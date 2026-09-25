/**
 * 验收测试（红队，real-process / 重型门控）：motionPrompt 拆分后的生成链路端到端
 *
 * 设计文档（state.md）对应谓词（含 §验证方案 的 driver 错位修正——motion 生成落在
 * daily-selection（选片时），rerun CLI 只读不写 motion_prompt，因此驱动序列为）：
 *   ① 3.P5：先跑一次含新 motion 阶段的精选链路（覆盖目标日）→ 再跑 rerun CLI 出片
 *      assert: exit==0 && portrait_artifact_exists==true && landscape_artifact_exists==true
 *              && motion_prompt!=""
 *   ② 6.P1：精选链路注入不可达 AI_MOTION_BASE_URL → 链路仍成功结束并回退默认运动描述
 *      assert: exit==0 && portrait_artifact_exists==true && landscape_artifact_exists==true
 *      negate: 不得抛出未捕获异常、不得跳过当日视频产物；C6：失败不写库（motion_prompt 保持空）
 *   ③ 6.P2：运动描述生成失败当日，精选主流程不受影响
 *      assert: daily_pick_row_exists==true && wallpaper_http_status==200 && content_type contains "image"
 *   ④ 6.P3：失败在 stderr 留下运动描述相关可诊断行（C6：console.warn 落 stdout/stderr，
 *      不能只 job.log）assert: 匹配行数 >= 1 且含运动描述相关关键词
 *   ⑤ 3.P6：3 张内容差异明显的照片各生成一次运动描述 → 差异化（防模板化硬编码）
 *      assert: 三者两两不相同（字符集重叠率 < 0.7）且每段长度 >= 15 字符
 *
 * ⚠️ 评估顺序依赖（设计 §验证方案 逐字）：3.P4（姊妹文件 motion-prompt-db）必须在 ① 的
 * 成功精选之后、② 的失败注入之前求值——② 的失败运行会把该日 motion_prompt 置空（C6 预期）。
 *
 * 重型门控：本套件含 GPU 真跑（单腿 40~90min）与全量精选链路，仅在 WVQA_HEAVY=1 时执行；
 * 门控关闭时逐谓词写跳过原因 artifact（设计：不得静默置 PASS）+ 可见 skip。
 *
 * QA 真机绑定项：
 *   - WVQA_HEAVY=1                    重型真跑总开关
 *   - WVQA_DB_PATH / DATABASE_PATH    SQLite 路径
 *   - WVQA_PICK_DATE                  目标精选日（缺省取库内最新）
 *   - WVQA_PORTRAIT_MP4 / WVQA_LANDSCAPE_MOV  重跑产物落盘路径（与场景 2/3 套件同名绑定）
 *   - WVQA_BACKEND_BASE               后端基址（缺省 http://127.0.0.1:3000）
 *   - WVQA_SELECTION_CMD              精选链路命令模板（{date} 占位；缺省用仓内 backfill CLI）
 *   - WVQA_RERUN_CMD                  壁纸视频重跑命令模板（{date} 占位；缺省仓内 rerun script）
 *   - WVQA_MOTION_PHOTOS              3 张内容差异明显照片的路径（逗号分隔）
 *   - WVQA_MOTION_CMD                 单张照片运动描述命令模板（{photo} 占位，描述文本走 stdout；
 *                                     缺省探测 rerun CLI 的 --motion-only 形态——§验证方案声明的
 *                                     两种注入接缝之二，均未落地即真红）
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";

const ARTIFACT_DIR = "/tmp/autopilot-artifacts";
const HEAVY = process.env.WVQA_HEAVY === "1";
const DB_PATH = (process.env.WVQA_DB_PATH ?? process.env.DATABASE_PATH ?? "").trim();
const BACKEND_BASE = (process.env.WVQA_BACKEND_BASE ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const PORTRAIT_MP4 = (process.env.WVQA_PORTRAIT_MP4 ?? "").trim();
const LANDSCAPE_MOV = (process.env.WVQA_LANDSCAPE_MOV ?? "").trim();
const SELECTION_CMD = (
  process.env.WVQA_SELECTION_CMD ??
  "pnpm --filter @relight/backend backfill:daily-picks --from={date} --to={date} --yes"
).trim();
const RERUN_CMD = (
  process.env.WVQA_RERUN_CMD ??
  "pnpm --filter @relight/backend run wallpaper-video:rerun -- --pickDate={date}"
).trim();
const MOTION_PHOTOS = (process.env.WVQA_MOTION_PHOTOS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MOTION_CMD = (process.env.WVQA_MOTION_CMD ?? "").trim();

function writeArtifact(id: string, content: string): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
  wallMs: number;
}

function runCmd(cmdTemplate: string, vars: Record<string, string>, timeoutMs: number): CmdResult {
  const cmd = Object.entries(vars).reduce(
    (acc, [k, v]) => acc.split(`{${k}}`).join(v),
    cmdTemplate,
  );
  const startedAt = Date.now();
  const res = spawnSync(cmd, {
    shell: true,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    wallMs: Date.now() - startedAt,
  };
}

function openDb(): Database.Database {
  expect(DB_PATH, "WVQA_DB_PATH / DATABASE_PATH 未绑定（真红）").not.toBe("");
  expect(fs.existsSync(DB_PATH), `数据库不存在: ${DB_PATH}`).toBe(true);
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

function resolvePickDate(): string {
  if (process.env.WVQA_PICK_DATE?.trim()) return process.env.WVQA_PICK_DATE.trim();
  const db = openDb();
  try {
    const row = db
      .prepare("SELECT pick_date FROM daily_picks ORDER BY pick_date DESC LIMIT 1")
      .get() as { pick_date: string } | undefined;
    expect(row, "库内无任何 daily_picks 记录，无法解析目标日").toBeTruthy();
    return row!.pick_date;
  } finally {
    db.close();
  }
}

function readMotionPrompt(pickDate: string): string {
  const db = openDb();
  try {
    const row = db
      .prepare("SELECT motion_prompt FROM daily_picks WHERE pick_date = ?")
      .get(pickDate) as { motion_prompt: string | null } | undefined;
    return row?.motion_prompt ?? "";
  } finally {
    db.close();
  }
}

// ---- 门控与跳过留痕 ----

if (!HEAVY) {
  for (const id of ["场景3.P5", "场景3.P6", "场景6.P1", "场景6.P2", "场景6.P3"]) {
    writeArtifact(
      `${id}-跳过原因`,
      "WVQA_HEAVY!=1——本谓词需真跑 GPU 出片 / 全量精选链路 / 外部模型（设计：真跑是最重验证动作，" +
        "需排 GPU 空闲窗口单独执行）。求值时设 WVQA_HEAVY=1 并绑定 QA 项后重跑本套件；不得静默置 PASS。",
    );
  }
  console.warn(
    "[motion-prompt-generation] WVQA_HEAVY!=1——3.P5/3.P6/6.P1/6.P2/6.P3 skip（逐谓词留跳过原因 artifact）",
  );
}
const dHeavy = HEAVY ? describe : describe.skip;

// ============================================================================
// 驱动序列 ①：3.P5 真跑（成功路径）
// ============================================================================

dHeavy("场景 3.P5 [real-process]：精选链路 + 重跑端到端成功并落库运动描述", () => {
  let pickDate = "";

  beforeAll(() => {
    pickDate = resolvePickDate();
  });

  it(
    "第 1 步：含新 motion 阶段的精选链路覆盖目标日 → exit 0 且 motion_prompt 非空",
    () => {
      const res = runCmd(SELECTION_CMD, { date: pickDate }, 60 * 60 * 1000);
      writeArtifact(
        "场景3.P5-精选链路",
        JSON.stringify(
          {
            pickDate,
            cmd: SELECTION_CMD,
            exit: res.code,
            wallMs: res.wallMs,
            stdoutTail: res.stdout.slice(-2000),
            stderrTail: res.stderr.slice(-2000),
          },
          null,
          2,
        ),
      );
      expect(res.code, "精选链路退出码非 0（stderr tail 见 artifact 场景3.P5-精选链路）").toBe(0);
      const mp = readMotionPrompt(pickDate);
      expect(mp, "精选链路完成后 motion_prompt 仍为空——motion 阶段未生效").not.toBe("");
    },
    70 * 60 * 1000,
  );

  it(
    "第 2 步：rerun CLI 真跑出片 → exit 0 且竖版/横版产物存在",
    () => {
      const res = runCmd(RERUN_CMD, { date: pickDate }, 3 * 60 * 60 * 1000 + 30 * 60 * 1000);
      writeArtifact(
        "场景3.P5-rerun",
        JSON.stringify(
          {
            pickDate,
            cmd: RERUN_CMD,
            exit: res.code,
            wallMs: res.wallMs,
            stdoutTail: res.stdout.slice(-2000),
          },
          null,
          2,
        ),
      );
      // R1b：GPU 交互保护表现为零输出挂死——wallMs 一并记录供阶段 5 计时合流
      expect(res.code, "rerun 退出码非 0（GPU 挂死会走满超时，见 artifact）").toBe(0);
      expect(PORTRAIT_MP4, "WVQA_PORTRAIT_MP4 未绑定").not.toBe("");
      expect(LANDSCAPE_MOV, "WVQA_LANDSCAPE_MOV 未绑定").not.toBe("");
      expect(fs.existsSync(path.resolve(PORTRAIT_MP4)), `竖版产物不存在: ${PORTRAIT_MP4}`).toBe(
        true,
      );
      expect(fs.existsSync(path.resolve(LANDSCAPE_MOV)), `横版产物不存在: ${LANDSCAPE_MOV}`).toBe(
        true,
      );
      // 谓词字面量：motion_prompt != ""（第 1 步落库保证）
      expect(readMotionPrompt(pickDate)).not.toBe("");
    },
    3 * 60 * 60 * 1000 + 30 * 60 * 1000 + 60 * 1000,
  );
});

// ============================================================================
// 驱动序列 ②③④：6.P1 / 6.P2 / 6.P3（外部文本模型不可达的降级路径）
// ============================================================================

dHeavy("场景 6.P1/6.P2/6.P3 [real-process]：外部模型不可达 → 链路降级不回归", () => {
  let pickDate = "";

  beforeAll(() => {
    pickDate = resolvePickDate();
  });

  it(
    "6.P1：精选链路注入不可达 AI_MOTION_BASE_URL → exit 0（回退默认运动描述，不写库）",
    () => {
      const prev = process.env.AI_MOTION_BASE_URL;
      process.env.AI_MOTION_BASE_URL = "http://127.0.0.1:1"; // 不可达地址（端口 1 立即拒绝）
      try {
        const res = runCmd(SELECTION_CMD, { date: pickDate }, 60 * 60 * 1000);
        writeArtifact(
          "场景6.P1-精选链路",
          JSON.stringify(
            {
              pickDate,
              injectedBaseUrl: "http://127.0.0.1:1",
              exit: res.code,
              wallMs: res.wallMs,
              stderrTail: res.stderr.slice(-2000),
            },
            null,
            2,
          ),
        );
        // negate：不得抛出未捕获异常（未捕获异常 → 非零退出）
        expect(res.code, "精选链路在外部模型不可达时必须成功结束（exit 0）").toBe(0);
      } finally {
        if (prev === undefined) process.env.AI_MOTION_BASE_URL = undefined;
        else process.env.AI_MOTION_BASE_URL = prev;
      }
      // C6 逐字：任一步失败 → 不写库（保持 null/空），由分层解析链兜底
      const mp = readMotionPrompt(pickDate);
      writeArtifact("场景6.P1-落库校验", JSON.stringify({ pickDate, motionPrompt: mp }));
      expect(mp, "失败的运动描述不得写库（C6：保持空由 wallpaper-video 既有解析链兜底）").toBe("");
    },
    70 * 60 * 1000,
  );

  it(
    "6.P1（续）：失败注入后 rerun 出片 → 竖版/横版产物仍存在（不得跳过当日视频产物）",
    () => {
      const res = runCmd(RERUN_CMD, { date: pickDate }, 3 * 60 * 60 * 1000 + 30 * 60 * 1000);
      writeArtifact(
        "场景6.P1-rerun",
        JSON.stringify(
          { pickDate, exit: res.code, wallMs: res.wallMs, stdoutTail: res.stdout.slice(-2000) },
          null,
          2,
        ),
      );
      expect(res.code).toBe(0);
      expect(fs.existsSync(path.resolve(PORTRAIT_MP4)), `竖版产物不存在: ${PORTRAIT_MP4}`).toBe(
        true,
      );
      expect(fs.existsSync(path.resolve(LANDSCAPE_MOV)), `横版产物不存在: ${LANDSCAPE_MOV}`).toBe(
        true,
      );
    },
    3 * 60 * 60 * 1000 + 30 * 60 * 1000 + 60 * 1000,
  );

  it("6.P2：失败当日精选主流程不受影响——dailyPicks 行存在且静态壁纸端点返回图片", async () => {
    const db = openDb();
    const row = db.prepare("SELECT id FROM daily_picks WHERE pick_date = ?").get(pickDate);
    db.close();
    // 谓词字面量①：daily_pick_row_exists == true
    expect(row, `该日 dailyPicks 记录缺失: ${pickDate}`).toBeTruthy();
    const url = `${BACKEND_BASE}/api/daily/${pickDate}/wallpaper?width=1290&height=2796`;
    const res = await fetch(url);
    const contentType = res.headers.get("content-type") ?? "";
    writeArtifact("场景6.P2", JSON.stringify({ url, status: res.status, contentType }, null, 2));
    // 谓词字面量②③：wallpaper_http_status==200 && content_type contains "image"
    expect(res.status).toBe(200);
    expect(contentType).toContain("image");
  }, 60000);

  it(
    "6.P3：失败运行在 stderr 留下运动描述相关可诊断 warn/error 行（console.warn 落 stderr）",
    () => {
      // 复跑一次失败注入（秒级：模型不可达立即失败，不重跑 GPU），捕获 stderr 求 fs-grep 面
      const prev = process.env.AI_MOTION_BASE_URL;
      process.env.AI_MOTION_BASE_URL = "http://127.0.0.1:1";
      let res: CmdResult;
      try {
        res = runCmd(SELECTION_CMD, { date: pickDate }, 10 * 60 * 1000);
      } finally {
        if (prev === undefined) process.env.AI_MOTION_BASE_URL = undefined;
        else process.env.AI_MOTION_BASE_URL = prev;
      }
      const matched = res.stderr.split("\n").filter((l) => /motion/i.test(l));
      writeArtifact(
        "场景6.P3",
        JSON.stringify(
          { pickDate, matchedLines: matched.slice(0, 20), stderrTail: res.stderr.slice(-2000) },
          null,
          2,
        ),
      );
      // 谓词字面量：匹配行数 >= 1 且含运动描述相关关键词（console.warn/error 写 stderr）
      expect(
        matched.length,
        "stderr 无 motion 相关可诊断行——C6 要求失败必须 console.warn 留痕",
      ).toBeGreaterThanOrEqual(1);
    },
    15 * 60 * 1000,
  );
});

// ============================================================================
// 3.P6：3 张差异明显照片 → 差异化运动描述（防模板化硬编码）
// ============================================================================

/** 字符集 Jaccard 重叠率：|A∩B| / |A∪B|（谓词「字符集重叠率 < 0.7」） */
function charsetOverlap(a: string, b: string): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter++;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

/** 解析单张照片运动描述的驱动命令：QA 绑定模板优先，否则探测 rerun CLI 的 --motion-only 形态 */
function resolveMotionDriver(): string {
  if (MOTION_CMD) return MOTION_CMD;
  const probe = spawnSync(`${RERUN_CMD.split("{date}").join("1970-01-01")} --help`, {
    shell: true,
    encoding: "utf-8",
    timeout: 120000,
  });
  const help = `${probe.stdout}\n${probe.stderr}`;
  if (help.includes("--motion-only")) {
    return `${RERUN_CMD.split("{date}").join("1970-01-01")} --motion-only --photo={photo}`;
  }
  // 设计 §验证方案 声明的两种注入接缝（lib 导出函数 / --motion-only）均不可达 → 真红
  throw new Error(
    `CONTRACT_AMBIGUOUS: 设计文档声明 motion 生成接缝为「lib 级可导出函数」或「rerun CLI --motion-only」二选一，但两种形态均未探测到。请绑定 WVQA_MOTION_CMD（{photo} 占位，描述文本走 stdout）后重跑，或确认实现落点了声明中的接缝。--help 探测输出尾部：${help.slice(-600)}`,
  );
}

dHeavy("场景 3.P6 [det-machine]：3 张差异明显照片产出差异化运动描述", () => {
  it(
    "3 段描述两两字符集重叠率 < 0.7 且每段长度 ≥ 15 字符",
    () => {
      expect(
        MOTION_PHOTOS.length,
        "WVQA_MOTION_PHOTOS 未绑定——需 QA 指定 3 张内容差异明显的既有照片（真红）",
      ).toBeGreaterThanOrEqual(3);
      const driver = resolveMotionDriver();
      const outputs: string[] = [];
      for (const photo of MOTION_PHOTOS.slice(0, 3)) {
        expect(fs.existsSync(photo), `照片不存在: ${photo}`).toBe(true);
        const res = runCmd(driver, { photo }, 10 * 60 * 1000);
        writeArtifact(
          `场景3.P6-${path.basename(photo)}`,
          JSON.stringify(
            {
              photo,
              exit: res.code,
              stdout: res.stdout.slice(-1000),
              stderrTail: res.stderr.slice(-500),
            },
            null,
            2,
          ),
        );
        expect(res.code, `运动描述生成失败: ${photo}`).toBe(0);
        outputs.push(res.stdout.trim());
      }
      const lengths = outputs.map((o) => [...o].length);
      const [o0, o1, o2] = outputs;
      if (!o0 || !o1 || !o2) throw new Error("3 段运动描述输出缺失");
      const overlaps = [charsetOverlap(o0, o1), charsetOverlap(o0, o2), charsetOverlap(o1, o2)];
      writeArtifact(
        "场景3.P6",
        JSON.stringify({ lengths, overlaps: overlaps.map((o) => Number(o.toFixed(4))) }, null, 2),
      );
      // 谓词字面量：每段长度 >= 15 字符
      for (let i = 0; i < 3; i++) {
        expect(lengths[i], `第 ${i + 1} 段描述长度 ${lengths[i]} < 15`).toBeGreaterThanOrEqual(15);
      }
      // 谓词字面量：两两不相同（字符集重叠率 < 0.7）
      for (let i = 0; i < 3; i++) {
        const ov = overlaps[i];
        expect(
          ov,
          `描述 ${i + 1} 与其两两组合重叠率 ${ov?.toFixed(3)} >= 0.7——疑似模板化输出`,
        ).toBeLessThan(0.7);
      }
    },
    35 * 60 * 1000,
  );
});

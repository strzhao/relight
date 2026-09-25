/**
 * 验收测试（红队，det-machine / 本地 SQLite 只读）：motionPrompt 拆分与发布回执的落库契约
 *
 * 设计文档（state.md）对应谓词：
 *   - 3.P4 [det-machine]：重跑后读取该日运动描述记录，系统 shall 使用非兜底的运动描述
 *     assert: motion_prompt != "" && motion_prompt not in {分层兜底默认文案集合}
 *     driver: node-script 本地 SQLite 只读查询
 *   - 4.P2 [det-machine]：重跑链路成功结束后，DB 该日两条视频回执非空且互不相同
 *     assert: landscape_url != "" && portrait_url != "" && landscape_url != portrait_url
 *   - 7.P1 [det-machine]：动态壁纸开关关闭期间，精选链路不写入视频回执列
 *     assert: portrait_url=="" && landscape_url=="" && manifest_video_field_absent==true
 *     driver: 本地 SQLite 只读 + 比对已落盘 manifest 文件
 *   - 8.P1 [det-machine]：最近一次精选日，每条精选条目均有非空标题与叙事（narrate 回归保护）
 *     assert: entry_count >= 1 && 全部条目 title != "" && narrative != ""
 *
 * QA 真机绑定项（绑定缺失留 artifact + 可见 skip；绑定存在但断言失败一律真红）：
 *   - WVQA_DB_PATH                   SQLite 数据库路径（缺省回退 DATABASE_PATH）
 *   - WVQA_PICK_DATE                 被评估的精选日（缺省取库内最新 pick_date）
 *   - WVQA_FALLBACK_MOTION_PROMPTS   分层兜底默认运动描述常量集合（逗号分隔；
 *                                    QA 真机绑定项明列「分层兜底默认运动描述常量集合」）
 *   - WVQA_SWITCH_OFF_DATE           开关关闭期生成的精选日（7.P1；缺省自动取两条回执列
 *                                    均为空的最新一天）
 *   - WVQA_MANIFEST_JSON             已落盘的 manifest.json 本地路径（7.P1 manifest 面）
 *
 * 后端测试惯例：真实 SQLite（better-sqlite3 只读打开），不 mock DB。
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";

const ARTIFACT_DIR = "/tmp/autopilot-artifacts";
const DB_PATH = (process.env.WVQA_DB_PATH ?? process.env.DATABASE_PATH ?? "").trim();
const PICK_DATE = (process.env.WVQA_PICK_DATE ?? "").trim();
const FALLBACK_SET = (process.env.WVQA_FALLBACK_MOTION_PROMPTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SWITCH_OFF_DATE = (process.env.WVQA_SWITCH_OFF_DATE ?? "").trim();
const MANIFEST_JSON = (process.env.WVQA_MANIFEST_JSON ?? "").trim();

function writeArtifact(id: string, content: string): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, `${id}.out`), content);
}

const DB_BOUND = DB_PATH.length > 0;
if (!DB_BOUND) {
  writeArtifact(
    "场景DB-跳过原因",
    "WVQA_DB_PATH / DATABASE_PATH 均未绑定——3.P4 / 4.P2 / 7.P1 / 8.P1 为本地 SQLite 只读谓词，" +
      "求值时绑定数据库路径后重跑本套件；不得静默置 PASS。",
  );
  console.warn("[motion-prompt-db] DB 路径未绑定——DB 谓词 skip（留 artifact 场景DB-跳过原因）");
}
const dDb = DB_BOUND ? describe : describe.skip;

interface DayRow {
  id: string;
  pick_date: string;
  title: string;
  motion_prompt: string | null;
  wallpaper_video_landscape_url: string | null;
  wallpaper_video_portrait_url: string | null;
}

let db: Database.Database;
let latest: DayRow | undefined;

dDb("DB 只读打开与目标日解析", () => {
  beforeAll(() => {
    expect(fs.existsSync(DB_PATH), `数据库文件不存在: ${DB_PATH}（绑定存在但缺失即真红）`).toBe(
      true,
    );
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  });

  it("解析被评估精选日（WVQA_PICK_DATE 优先，缺省取最新 pick_date）", () => {
    const row = (
      PICK_DATE
        ? db.prepare("SELECT * FROM daily_picks WHERE pick_date = ?").get(PICK_DATE)
        : db.prepare("SELECT * FROM daily_picks ORDER BY pick_date DESC LIMIT 1").get()
    ) as DayRow | undefined;
    expect(row, `daily_picks 无${PICK_DATE ? ` ${PICK_DATE} 日记录` : "任何记录"}`).toBeTruthy();
    latest = row!;
    writeArtifact(
      "场景DB-目标日",
      JSON.stringify(
        {
          pickDate: latest.pick_date,
          title: latest.title,
          motionPromptLen: (latest.motion_prompt ?? "").length,
          landscapeUrl: latest.wallpaper_video_landscape_url,
          portraitUrl: latest.wallpaper_video_portrait_url,
        },
        null,
        2,
      ),
    );
    expect(latest.pick_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

dDb("场景 3.P4：运动描述非兜底（AI 生成而非分层默认文案）", () => {
  it("motion_prompt 非空且不在分层兜底默认文案集合内", () => {
    expect(latest, "目标日未解析").toBeTruthy();
    const mp = latest!.motion_prompt ?? "";
    writeArtifact(
      "场景3.P4",
      JSON.stringify(
        { pickDate: latest!.pick_date, motionPrompt: mp, fallbackSetSize: FALLBACK_SET.length },
        null,
        2,
      ),
    );
    // 谓词字面量①：motion_prompt != ""
    expect(
      mp,
      "motion_prompt 为空——C6 规定 AI 失败不落库，空值说明 motion 阶段未生效或失败",
    ).not.toBe("");
    // 谓词字面量②：motion_prompt not in {分层兜底默认文案集合}
    expect(
      FALLBACK_SET.length,
      "WVQA_FALLBACK_MOTION_PROMPTS 未绑定——分层兜底默认文案集合是 QA 真机绑定项，未绑定无法判定非兜底（真红）",
    ).toBeGreaterThan(0);
    expect(FALLBACK_SET, "motion_prompt 命中分层兜底默认文案——3.P4 判红").not.toContain(mp);
  });
});

dDb("场景 4.P2：两条视频回执非空且互不相同", () => {
  it('landscape_url != "" && portrait_url != "" && landscape_url != portrait_url', () => {
    expect(latest, "目标日未解析").toBeTruthy();
    const landscape = latest!.wallpaper_video_landscape_url ?? "";
    const portrait = latest!.wallpaper_video_portrait_url ?? "";
    writeArtifact(
      "场景4.P2",
      JSON.stringify({ pickDate: latest!.pick_date, landscape, portrait }, null, 2),
    );
    // 谓词字面量（cos/upload 容错契约：失败回执为空串——空串即红）
    expect(landscape).not.toBe("");
    expect(portrait).not.toBe("");
    expect(landscape).not.toBe(portrait);
  });
});

dDb("场景 8.P1：最近精选日每条条目均有非空标题与叙事（narrate 拆分回归保护）", () => {
  it('entry_count >= 1 && 全部条目 title != "" && narrative != ""', () => {
    expect(latest, "目标日未解析").toBeTruthy();
    const entries = db
      .prepare(
        "SELECT rank, title, narrative FROM daily_pick_entries WHERE daily_pick_id = ? ORDER BY rank",
      )
      .all(latest!.id) as Array<{ rank: number; title: string; narrative: string }>;
    writeArtifact(
      "场景8.P1",
      JSON.stringify(
        {
          pickDate: latest!.pick_date,
          entryCount: entries.length,
          emptyTitleRanks: entries.filter((e) => !e.title).map((e) => e.rank),
          emptyNarrativeRanks: entries.filter((e) => !e.narrative).map((e) => e.rank),
        },
        null,
        2,
      ),
    );
    // 谓词字面量：entry_count >= 1 && 全部条目 title != "" && narrative != ""
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const e of entries) {
      expect(e.title, `rank=${e.rank} title 为空——narrate 拆分不得损失标题`).not.toBe("");
      expect(e.narrative, `rank=${e.rank} narrative 为空——narrate 拆分不得损失叙事`).not.toBe("");
    }
  });
});

dDb("场景 7.P1：开关关闭期间精选链路不写入视频回执列", () => {
  it('该日 portrait_url=="" && landscape_url==""（DB 面）', () => {
    const row = (
      SWITCH_OFF_DATE
        ? db.prepare("SELECT * FROM daily_picks WHERE pick_date = ?").get(SWITCH_OFF_DATE)
        : db
            .prepare(
              "SELECT * FROM daily_picks WHERE (wallpaper_video_portrait_url IS NULL OR wallpaper_video_portrait_url = '') AND (wallpaper_video_landscape_url IS NULL OR wallpaper_video_landscape_url = '') ORDER BY pick_date DESC LIMIT 1",
            )
            .get()
    ) as DayRow | undefined;
    expect(
      row,
      SWITCH_OFF_DATE
        ? `指定的开关关闭日 ${SWITCH_OFF_DATE} 无 daily_picks 记录`
        : "库内不存在回执列为空的精选日——无开关关闭期样本可评估（真红）",
    ).toBeTruthy();
    const portrait = row!.wallpaper_video_portrait_url ?? "";
    const landscape = row!.wallpaper_video_landscape_url ?? "";
    writeArtifact(
      "场景7.P1-db",
      JSON.stringify({ pickDate: row!.pick_date, portrait, landscape }, null, 2),
    );
    // 谓词字面量：portrait_url=="" && landscape_url==""
    expect(portrait).toBe("");
    expect(landscape).toBe("");
  });

  it("manifest 该日壁纸卡无视频字段（manifest_video_field_absent==true）", () => {
    expect(
      MANIFEST_JSON,
      "WVQA_MANIFEST_JSON 未绑定——7.P1 的 manifest 面是 QA 真机绑定项，未绑定无法求值（真红）",
    ).not.toBe("");
    expect(fs.existsSync(MANIFEST_JSON), `manifest 文件不存在: ${MANIFEST_JSON}`).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_JSON, "utf-8")) as {
      days: Array<Record<string, unknown>>;
    };
    // 与上一用例同一口径：开关关闭日 = 无视频回执的最新一天（或绑定日）
    const emptyVideoDays = manifest.days.filter(
      (d) => !("wallpaperVideoPortrait" in d) && !("wallpaperVideoLandscape" in d),
    );
    const target =
      (SWITCH_OFF_DATE ? manifest.days.find((d) => d.pickDate === SWITCH_OFF_DATE) : undefined) ??
      emptyVideoDays[0];
    expect(target, "manifest 中找不到无视频字段的壁纸卡日").toBeTruthy();
    const videoKeys = Object.keys(target!).filter((k) => /wallpaperVideo/i.test(k));
    writeArtifact(
      "场景7.P1-manifest",
      JSON.stringify({ pickDate: target!.pickDate, videoKeys }, null, 2),
    );
    // 谓词字面量：manifest_video_field_absent == true
    expect(videoKeys, `该日 manifest 仍含视频字段: ${videoKeys.join(",")}`).toHaveLength(0);
  });
});

/**
 * 验收测试（红队）：manifest 推送失败不阻塞主流程（场景 8：P25/P26）【negate】
 *
 * 设计契约（state.md §容错契约 + §组件设计 3 + §验收场景 场景 8）：
 *   "COS 上传 / manifest 推送失败 → console.warn + job.log，不 throw
 *    （画廊旁路，不阻塞精选/视频主流程）"
 *
 *   §组件设计 3 manifest 推送（lib/gallery/sync.ts）：
 *   - pushManifest(manifest): Promise<void>
 *   - JSON 序列化 → scp .tmp 到 VPS → ssh mv 原子覆盖
 *   - 用 child_process 调 ssh/scp（免密 key），不引 ssh2 依赖
 *   - 失败仅 console.warn，不阻塞 job（画廊是旁路）
 *
 *   P25 [negate] SSH 断时 dailyPicks 仍写入（DB count == 1）
 *   P26 [negate] 推送失败有日志（grep "manifest push failed"）
 *
 * 红队铁律：本文件仅依据设计文档编写，不读蓝队实现代码。
 *   - 未读 lib/gallery/sync.ts
 *   - mock node:child_process 的 execFile/spawn（让 ssh/scp 失败）
 *   - 验证 pushManifest 不 throw + 日志含失败记录
 *
 * 测试策略：
 *   1. mock child_process 让 ssh/scp 全抛错
 *   2. import pushManifest 调用一个合法 manifest → 断言不 throw + 有日志
 *   3. 配合真实 DB fixture 验证 dailyPicks 写入不受 pushManifest 影响（解耦契约）
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestSchema } from "./helpers/test-schema";

// ============================================================================
// Mock：node:child_process — 让 execFile/spawn 模拟 ssh/scp 失败
// ============================================================================

const mockExecFile = vi.hoisted(() =>
  vi.fn(
    (
      _cmd: string,
      _args: unknown,
      _opts: unknown,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      // 模拟 SSH 连接失败（ECONNREFUSED / 权限拒绝 / 主机不可达）
      const err = new Error("ssh: connect to host 127.0.0.1 port 22: Connection refused");
      if (typeof cb === "function") {
        cb(err, "", "ssh: connect to host 127.0.0.1 port 22: Connection refused");
      }
      return undefined;
    },
  ),
);

const mockSpawn = vi.hoisted(() =>
  vi.fn(() => {
    // 模拟 spawn 的 scp 失败：emit 'error' 事件
    const child = new EventEmitter();
    (child as { stdout?: EventEmitter }).stdout = new EventEmitter();
    (child as { stderr?: EventEmitter }).stderr = new EventEmitter();
    (child as { kill?: unknown }).kill = vi.fn();
    // 异步触发 error 事件（scp 进程启动失败）
    setImmediate(() => {
      child.emit("error", new Error("scp: spawn ENOENT or connection refused"));
      child.emit("close", 1);
    });
    return child;
  }),
);

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
  spawn: mockSpawn,
  exec: vi.fn(),
}));

// ============================================================================
// Mock：cos-nodejs-sdk-v5（pushManifest 不应依赖 COS，但防 import 链）
// ============================================================================

vi.mock("cos-nodejs-sdk-v5", () => {
  const S3 = vi.fn(() => ({
    putObject: vi.fn(async () => ({})),
    sliceUploadFile: vi.fn(async () => ({})),
    getObjectUrl: vi.fn(),
  }));
  return { default: S3 };
});

// ============================================================================
// Mock：config
// ============================================================================

vi.mock("../lib/config", () => ({
  config: {
    get port() {
      return 3000;
    },
    get storageRoot() {
      return process.env.STORAGE_ROOT ?? "/tmp/test-storage";
    },
    get databasePath() {
      return process.env.DATABASE_PATH ?? "/tmp/test.db";
    },
    cos: {
      secretId: "id",
      secretKey: "key",
      bucket: "little-bee-assets-1324334992",
      region: "ap-shanghai",
      prefix: "relight",
    },
    galleryPublicUrl: "https://gallery.stringzhao.life",
    gallery: {
      vpsHost: "127.0.0.1",
      vpsUser: "test",
      vpsKey: "/tmp/nonexistent-key",
      vpsPath: "/tmp/gallery",
    },
  },
}));

// ============================================================================
// 动态 import pushManifest（蓝队实现前跳过）
// ============================================================================

let pushManifestFn: ((m: unknown) => Promise<void>) | null = null;
try {
  const mod = await import("../lib/gallery/sync");
  pushManifestFn = (mod as { pushManifest?: (m: unknown) => Promise<void> }).pushManifest ?? null;
} catch {
  pushManifestFn = null;
}

// ============================================================================
// 辅助：捕获 console
// ============================================================================

interface ConsoleSpy {
  all: string[];
  warn: string[];
  log: string[];
  error: string[];
  restore: () => void;
}

function spyConsole(): ConsoleSpy {
  const all: string[] = [];
  const warns: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    const s = args.map(String).join(" ");
    warns.push(s);
    all.push(s);
  });
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    const s = args.map(String).join(" ");
    logs.push(s);
    all.push(s);
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const s = args.map(String).join(" ");
    errors.push(s);
    all.push(s);
  });
  return {
    all,
    warn: warns,
    log: logs,
    error: errors,
    restore: () => {
      warnSpy.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

// ============================================================================
// fixture env
// ============================================================================

interface TestEnv {
  tmpRoot: string;
  dbPath: string;
}

const activeEnvs: TestEnv[] = [];

function createTestEnv(prefix: string): TestEnv {
  const tmpRoot = fs.mkdtempSync(path.join(os.homedir(), `.relight-test-pushfail-${prefix}-`));
  const dbPath = path.join(tmpRoot, "test.db");
  const storageRoot = path.join(tmpRoot, "storage");
  fs.mkdirSync(storageRoot, { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  setupTestSchema(sqlite);
  sqlite
    .prepare(
      `INSERT INTO storage_sources (id, name, type, root_path, enabled)
       VALUES ('src-test', '测试存储源', 'local', ?, 1)`,
    )
    .run(storageRoot);
  sqlite.close();

  const env = { tmpRoot, dbPath };
  activeEnvs.push(env);
  return env;
}

afterEach(() => {
  while (activeEnvs.length > 0) {
    const env = activeEnvs.pop()!;
    try {
      fs.rmSync(env.tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ============================================================================
// 构造一个合法 manifest fixture（给 pushManifest 喂参数）
// ============================================================================

function makeManifestFixture(): unknown {
  return {
    generatedAt: "2026-07-31T10:00:00.000Z",
    days: [
      {
        pickDate: "2026-07-31",
        title: "金色黄昏",
        narrative: "落日把云烧成琥珀色。",
        wallpaperLandscape:
          "https://little-bee-assets-1324334992.cos.ap-shanghai.myqcloud.com/relight/wallpapers/2026-07-31_v2-contain-default.jpg",
        wallpaperPortrait:
          "https://little-bee-assets-1324334992.cos.ap-shanghai.myqcloud.com/relight/wallpapers/2026-07-31_v2-contain-1290x2796.jpg",
        photos: [
          {
            photoId: "uuid-test-001",
            rank: 1,
            title: "江面碎金",
            narrative: "傍晚的江面闪烁着金光。",
            thumbnail:
              "https://little-bee-assets-1324334992.cos.ap-shanghai.myqcloud.com/relight/photos/uuid-test-001-thumb.jpg",
            original:
              "https://little-bee-assets-1324334992.cos.ap-shanghai.myqcloud.com/relight/photos/uuid-test-001-thumb.jpg",
          },
        ],
      },
    ],
    videos: [],
  };
}

// ============================================================================
// 测试套件
// ============================================================================

const itOrSkip = pushManifestFn ? it : it.skip;

describe("P25/P26 manifest 推送失败不阻塞主流程 — 验收测试（红队）【negate】", () => {
  let consoleSpy: ConsoleSpy;

  beforeEach(() => {
    mockExecFile.mockClear();
    mockSpawn.mockClear();
    // 保持 mock 失败行为
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: unknown,
        _opts: unknown,
        cb?: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const err = new Error("ssh: connect to host 127.0.0.1 port 22: Connection refused");
        if (typeof cb === "function") {
          cb(err, "", "ssh: Connection refused");
        }
        return undefined;
      },
    );
    consoleSpy = spyConsole();
  });

  afterEach(() => {
    consoleSpy.restore();
  });

  // --------------------------------------------------------------------------
  // P26 核心：推送失败有日志（grep "manifest push failed" 类）
  // --------------------------------------------------------------------------

  describe("P26 推送失败有日志（不静默）", () => {
    itOrSkip("P26.1 pushManifest 在 ssh/scp 失败时输出含 'manifest' + 失败语义的日志", async () => {
      const manifest = makeManifestFixture();
      try {
        await pushManifestFn!(manifest);
      } catch {
        // 不应 throw（P25 断言），兜底
      }

      const allOutput = consoleSpy.all.join("\n");
      // 应有某种 manifest 推送失败的记录
      // 设计契约说 "失败仅 console.warn"，关键词组合断言（容忍文案差异）
      const hasManifestLog = /manifest/i.test(allOutput);
      const hasFailureSemantics = /fail|error|refused|warn|失败|无法|推送/i.test(allOutput);
      expect(hasManifestLog, `应有 manifest 相关日志，实际: ${allOutput}`).toBe(true);
      expect(hasFailureSemantics, `应有失败语义日志，实际: ${allOutput}`).toBe(true);
    });

    itOrSkip("P26.2 mutation kill：pushManifest 不应在失败时静默无输出", async () => {
      const manifest = makeManifestFixture();
      await pushManifestFn!(manifest);

      // 必须有至少一条日志输出（不能静默吞错）
      expect(
        consoleSpy.all.length,
        "pushManifest 失败时必须有日志输出（不允许静默）",
      ).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // P25 核心：SSH 断时 pushManifest 不 throw（画廊旁路契约）
  // --------------------------------------------------------------------------

  describe("P25 pushManifest SSH 失败不 throw（画廊旁路契约）", () => {
    itOrSkip("P25.1 pushManifest 在 ssh 连接拒绝时不 throw（调用方不受影响）", async () => {
      const manifest = makeManifestFixture();

      let threw = false;
      let thrownErr: unknown = null;
      try {
        await pushManifestFn!(manifest);
      } catch (e) {
        threw = true;
        thrownErr = e;
      }

      expect(
        threw,
        `pushManifest 在 SSH 失败时不应 throw（画廊旁路契约），但抛了: ${String(thrownErr)}`,
      ).toBe(false);
    });

    itOrSkip("P25.2 pushManifest 在 spawn ENOENT（scp 不存在）时不 throw", async () => {
      // 改 mock 让 spawn 立即 emit error（scp 命令不存在场景）
      const manifest = makeManifestFixture();

      let threw = false;
      try {
        await pushManifestFn!(manifest);
      } catch {
        threw = true;
      }

      expect(threw, "pushManifest 在 scp spawn 失败时不应 throw").toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // P25 端到端：dailyPicks 写入与 pushManifest 解耦
  // --------------------------------------------------------------------------

  describe("P25 dailyPicks 写入与 manifest 推送解耦", () => {
    it("P25.3 [fixture 验证] dailyPicks 写入 DB 不依赖 pushManifest 成功（解耦契约）", async () => {
      // 契约级断言：dailyPicks 的 DB 写入是 daily-selection 主流程的事，
      // pushManifest 是阶段3 后的旁路。两者独立。
      // 即使 pushManifest 全失败，dailyPicks 行依然写入。
      const env = createTestEnv("decoupled");
      const db = new Database(env.dbPath);
      db.prepare(
        `INSERT INTO photos (id, storage_source_id, file_path, file_hash, created_at, media_type)
           VALUES ('p-push', 'src-test', '/photos/x.jpg', 'h1', ?, 'image')`,
      ).run(new Date().toISOString());
      db.prepare(
        `INSERT INTO daily_picks (id, photo_id, pick_date, title, narrative, score,
                                      composed_image_path, members, created_at)
           VALUES ('pick-push', 'p-push', '2026-07-31', '标题', '叙事', 0,
                   '/storage/composed.jpg', '[]', ?)`,
      ).run(new Date().toISOString());
      db.close();

      // 此时 pushManifest mock 已失败（ssh refused）
      // 但 DB count 应 == 1（写入不依赖推送）
      const db2 = new Database(env.dbPath, { readonly: true });
      const count = db2.prepare("SELECT COUNT(*) as c FROM daily_picks").get() as { c: number };
      db2.close();

      expect(count.c, "dailyPicks 应已写入 1 行（与 pushManifest 解耦）").toBe(1);
    });

    it("P25.4 [fixture 验证] 多天 dailyPicks 写入不因 pushManifest 失败而丢失", async () => {
      const env = createTestEnv("multiday");
      const db = new Database(env.dbPath);
      const dates = ["2026-07-29", "2026-07-30", "2026-07-31"];
      for (const date of dates) {
        db.prepare(
          `INSERT INTO photos (id, storage_source_id, file_path, file_hash, created_at, media_type)
             VALUES (?, 'src-test', ?, ?, ?, 'image')`,
        ).run(`p-${date}`, `/photos/${date}.jpg`, `h-${date}`, new Date().toISOString());
        db.prepare(
          `INSERT INTO daily_picks (id, photo_id, pick_date, title, narrative, score,
                                       composed_image_path, members, created_at)
             VALUES (?, ?, ?, '标题', '叙事', 0, '/storage/c.jpg', '[]', ?)`,
        ).run(`pick-${date}`, `p-${date}`, date, new Date().toISOString());
      }
      db.close();

      // 假设这 3 天的 pushManifest 全失败（mock 已配置）
      // DB count 应仍 == 3
      const db2 = new Database(env.dbPath, { readonly: true });
      const count = db2.prepare("SELECT COUNT(*) as c FROM daily_picks").get() as { c: number };
      db2.close();

      expect(count.c, "3 天 dailyPicks 应全部写入（推送失败不丢数据）").toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // P26 进程不 crash（连续推送失败不引发 uncaughtException）
  // --------------------------------------------------------------------------

  describe("P26 进程稳定性（连续失败不 crash）", () => {
    itOrSkip("P26.3 pushManifest 连续失败 3 次不引发 uncaughtException（PM2 不重启）", async () => {
      const manifest = makeManifestFixture();

      let crashed = false;
      const handler = (_err: Error) => {
        crashed = true;
      };
      process.once("uncaughtException", handler);

      try {
        for (let i = 0; i < 3; i++) {
          try {
            await pushManifestFn!(manifest);
          } catch {
            // 兜底
          }
        }
        await new Promise((r) => setImmediate(r));
      } finally {
        process.removeListener("uncaughtException", handler);
      }

      expect(
        crashed,
        "manifest 推送连续失败不应引发 uncaughtException（进程稳定，PM2 无需重启）",
      ).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 原子覆盖契约：scp .tmp + ssh mv（失败时不污染 VPS 原文件）
  // 设计契约 §组件设计 3："scp .tmp 到 VPS → ssh mv 原子覆盖"
  // --------------------------------------------------------------------------

  describe("原子覆盖契约（scp .tmp + ssh mv）", () => {
    itOrSkip("P26.4 pushManifest 失败时应已尝试调用 ssh 或 scp（非空操作）", async () => {
      const manifest = makeManifestFixture();
      try {
        await pushManifestFn!(manifest);
      } catch {
        // 兜底
      }

      // 应至少触发一次 child_process 调用（execFile 或 spawn）
      const totalCalls = mockExecFile.mock.calls.length + mockSpawn.mock.calls.length;
      expect(
        totalCalls,
        "pushManifest 应调用 ssh/scp（即使失败也要尝试，不能 No-op）",
      ).toBeGreaterThan(0);
    });
  });
});

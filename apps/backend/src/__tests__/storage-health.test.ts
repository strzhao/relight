/**
 * 单测：jobs/storage-health.ts — probeAllSources 翻转判定与去抖
 *
 * 用内存 SQLite + vi.mock("../db") getter 注入，真实 fs 造 healthy 目录与可断软链，
 * 直接验证翻转计数逻辑（首启不轰炸、去抖、healthy↔unmounted、unknown 防御、enabled 过滤）。
 *
 * 漂移模拟：保留软链 mountPoint、删除其目标 driftRealDir → lstat 成功但 realpath 失败
 *           → checkPathAccessibility 判为 "unmounted"（与 prod 软链漂移同源）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as realSchema from "../db/schema";
import { probeAllSources } from "../jobs/storage-health";
import { getSettingValue, setSettingValue } from "../lib/settings";
import { setupTestSchema } from "./helpers/test-schema";

// getter mock：运行时动态读 holder.db，确保 beforeAll 注入后被测模块能拿到真实实例
const __holder = vi.hoisted(() => ({
  db: null as BetterSQLite3Database<typeof realSchema> | null,
}));

vi.mock("../db", () => ({
  get db() {
    return __holder.db;
  },
  schema: realSchema,
}));

let sqlite: Database.Database;
let healthyRealDir: string; // healthy 源直指，永不断
let driftRealDir: string; // drift 源软链的目标，删它造漂移
let mountPoint: string; // 软链 → driftRealDir（drift 源指向它）
let healthyId: string;
let driftId: string;
let disabledId: string;

beforeAll(() => {
  healthyRealDir = fs.mkdtempSync(path.join(os.tmpdir(), "relight-sh-healthy-"));
  driftRealDir = fs.mkdtempSync(path.join(os.tmpdir(), "relight-sh-drift-"));
  mountPoint = path.join(os.tmpdir(), `relight-sh-mount-${crypto.randomUUID()}`);
  fs.symlinkSync(driftRealDir, mountPoint);

  sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  __holder.db = drizzle(sqlite, { schema: realSchema });
  setupTestSchema(sqlite);

  healthyId = crypto.randomUUID();
  driftId = crypto.randomUUID();
  disabledId = crypto.randomUUID();

  const ins = sqlite.prepare(
    "INSERT INTO storage_sources (id, name, type, root_path, enabled) VALUES (?, ?, 'local', ?, ?)",
  );
  ins.run(healthyId, "健康源", healthyRealDir, 1);
  ins.run(driftId, "漂移源", mountPoint, 1);
  ins.run(disabledId, "禁用源", "/tmp/__nonexistent__", 0);
});

afterAll(() => {
  sqlite?.close();
  for (const p of [mountPoint, healthyRealDir, driftRealDir]) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  }
});

function dbStatus(id: string): string | null {
  const row = sqlite.prepare("SELECT status FROM storage_sources WHERE id = ?").get(id) as
    | { status: string | null }
    | undefined;
  return row?.status ?? null;
}

function lastStatus(id: string): Promise<string | null> {
  return getSettingValue(`storage.health.${id}.lastStatus`);
}

async function setLastStatus(id: string, v: string): Promise<void> {
  await setSettingValue(`storage.health.${id}.lastStatus`, v);
}

/** 造漂移：删软链目标（软链本身保留）→ realpath 失败 → unmounted */
function breakMount(): void {
  try {
    fs.rmSync(driftRealDir, { recursive: true, force: true });
  } catch {
    // 忽略
  }
}

/** 恢复：重建软链目标目录 */
function restoreMount(): void {
  if (!fs.existsSync(driftRealDir)) {
    fs.mkdirSync(driftRealDir, { recursive: true });
  }
}

describe("probeAllSources — 存储源可达性探测", () => {
  beforeEach(() => {
    restoreMount();
    sqlite.prepare("DELETE FROM settings").run();
    sqlite.prepare("UPDATE storage_sources SET status = NULL, last_error = NULL").run();
  });

  it("enabled=false 的源不探测（status 保持 null、不出现在明细）", async () => {
    const r = await probeAllSources(() => {});
    expect(r.sources.find((s) => s.id === disabledId)).toBeUndefined();
    expect(dbStatus(disabledId)).toBeNull();
  });

  it("首启正常（null→healthy）不计翻转，避免全员恢复轰炸", async () => {
    const r = await probeAllSources(() => {});
    expect(r.overall).toBe("healthy");
    expect(r.flippedCount).toBe(0);
    expect(dbStatus(healthyId)).toBe("healthy");
    expect(await lastStatus(healthyId)).toBe("healthy");
  });

  it("首启漂移（null→unmounted）计翻转——首启就挂要告警", async () => {
    breakMount();
    const r = await probeAllSources(() => {});
    expect(r.overall).toBe("unhealthy");
    expect(r.flippedCount).toBe(1); // 仅 driftId：null→unmounted
    expect(dbStatus(driftId)).toBe("unmounted");
  });

  it("状态不变不计翻转（去抖）", async () => {
    await probeAllSources(() => {});
    const r = await probeAllSources(() => {});
    expect(r.flippedCount).toBe(0);
  });

  it("healthy→unmounted 计翻转", async () => {
    await probeAllSources(() => {}); // 建立 healthy 基线
    breakMount();
    const r = await probeAllSources(() => {});
    expect(r.flippedCount).toBe(1);
    expect(dbStatus(driftId)).toBe("unmounted");
    expect(r.overall).toBe("unhealthy");
  });

  it("unmounted→healthy 计翻转（恢复）", async () => {
    breakMount();
    await probeAllSources(() => {}); // 建立 unmounted 基线
    restoreMount();
    const r = await probeAllSources(() => {});
    expect(r.flippedCount).toBe(1);
    expect(dbStatus(driftId)).toBe("healthy");
    expect(r.overall).toBe("healthy");
  });

  it("涉及 unknown 不触发翻转（防御首启/未探测噪音），但状态仍更新", async () => {
    await setLastStatus(driftId, "unknown");
    const r = await probeAllSources(() => {});
    expect(r.flippedCount).toBe(0);
    expect(await lastStatus(driftId)).toBe("healthy"); // 状态已推进到 healthy
  });
});

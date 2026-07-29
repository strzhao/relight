import type { Job } from "bullmq";
/**
 * 单元测试：src/jobs/daily-push.ts dailyPushWorker
 *
 * 覆盖（基于「## 验收场景 场景1/4/5/6」谓词）：
 * - 开关关 → skip + 状态行 `[daily-push] skipped reason=disabled`
 * - 无精选 → skip + 状态行 `[daily-push] skipped reason=no_pick`
 * - 正常发送成功 → 状态行 `[daily-push] success ... errcode=0` + 恰好一次出站调用
 * - errcode≠0 → 状态行 `[daily-push] failed ... errcode=X errmsg=Y` + throw（触发 BullMQ 重试）
 * - 网络异常 → 状态行 `[daily-push] failed ...` + throw
 *
 * 依赖注入策略：
 * - mock push lib 的 compress/send/settings
 * - worker 用 `console.log` 输出结构化状态行（QA 时 worker stdout 重定向到 log 文件供 fs-grep）
 *   → 单测里 spy console.log 断言状态行内容
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mock push lib ----
const mockGetSettings = vi.hoisted(() => vi.fn());
const mockSetSettings = vi.hoisted(() => vi.fn());
const mockCompress = vi.hoisted(() => vi.fn());
const mockSend = vi.hoisted(() => vi.fn());
const WeComRejectedError = vi.hoisted(
  () =>
    class WeComRejectedError extends Error {
      readonly errcode: number;
      readonly errmsg: string;
      constructor(errcode: number, errmsg: string) {
        super(`WECOM_REJECTED: errcode=${errcode} errmsg=${errmsg}`);
        this.name = "WeComRejectedError";
        this.errcode = errcode;
        this.errmsg = errmsg;
      }
    },
);

vi.mock("../lib/push/wechat", () => ({
  WECOM_IMAGE_MAX_BYTES: 2 * 1024 * 1024,
  WECOM_WEBHOOK_REGEX:
    /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9-]+$/,
  getDailyPushSettings: mockGetSettings,
  setDailyPushSettings: mockSetSettings,
  compressForWeCom: mockCompress,
  sendWallpaperToWeCom: mockSend,
  WeComRejectedError,
}));

// ---- Mock db (daily_picks) ----
const mockDb = vi.hoisted(() => ({ select: vi.fn() }));
const mockSchema = vi.hoisted(() => ({
  dailyPicks: {
    pickDate: "dailyPicks.pick_date",
    composedImagePath: "dailyPicks.composed_image_path",
  },
}));

vi.mock("../db", () => ({ db: mockDb, schema: mockSchema }));

vi.mock("../lib/wallpaper/composer", () => ({
  composedCachePath: vi.fn(() => "/tmp/fake-composed.jpg"),
  // 竖版现场合成兜底用（动态 import）：返回假路径，readFile 已被 mock 为成功
  composeAndSave: vi.fn(async () => "/tmp/fake-composed-portrait.jpg"),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => Buffer.from("fake-jpg")),
}));

vi.mock("../lib/config", () => ({
  config: { storageRoot: "/tmp" },
}));

import { dailyPushWorker } from "../jobs/daily-push";

const VALID = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123";

function chainableMock(result: unknown[] = []) {
  const fn = (..._args: unknown[]) => chainableMock(result);
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === "then") return (resolve: (v: unknown) => unknown) => resolve(result);
      return chainableMock(result);
    },
  });
}

function makeJob(data: Record<string, unknown> = {}): Job {
  return {
    data,
    id: "daily-push-job-001",
    name: "daily-push-cron",
    log: vi.fn(),
    updateProgress: vi.fn(),
  } as unknown as Job;
}

describe("dailyPushWorker", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCompress.mockResolvedValue(Buffer.from("compressed"));
    mockSend.mockResolvedValue({ errcode: 0, errmsg: "ok" });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("开关关闭时 skip + 输出 [daily-push] skipped reason=disabled + 不发送", async () => {
    mockGetSettings.mockResolvedValue({ webhook: VALID, enabled: false });
    const job = makeJob();
    await dailyPushWorker(job);
    const logs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain("[daily-push] skipped");
    expect(logs).toContain("disabled");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("webhook 未配置时 skip + 输出 skipped reason=no_webhook", async () => {
    mockGetSettings.mockResolvedValue({ webhook: "", enabled: true });
    const job = makeJob();
    await dailyPushWorker(job);
    const logs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain("[daily-push] skipped");
    expect(logs).toContain("no_webhook");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("当天无精选时 skip + 输出 [daily-push] skipped reason=no_pick", async () => {
    mockGetSettings.mockResolvedValue({ webhook: VALID, enabled: true });
    mockDb.select.mockReturnValue(chainableMock([]));
    const job = makeJob();
    await dailyPushWorker(job);
    const logs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain("[daily-push] skipped");
    expect(logs).toContain("no_pick");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("正常发送成功 → [daily-push] success ... errcode=0 + 横版出站调用", async () => {
    // AP-5：横版成功后追加竖版推送（1290×2796），send 总调用 2 次（横+竖）。
    // 竖版 readFile 缓存命中（mock 总返回 buffer）→ compress → send 第 2 次。
    mockGetSettings.mockResolvedValue({ webhook: VALID, enabled: true });
    mockDb.select.mockReturnValue(
      chainableMock([{ pickDate: "2026-07-19", composedImagePath: "/tmp/pick.jpg" }]),
    );
    const job = makeJob();
    await dailyPushWorker(job);
    const logs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain("[daily-push] success");
    expect(logs).toContain("errcode=0");
    // 横版 1 次 + 竖版 1 次（AP-5 双 send 契约）
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("errcode≠0 时输出 [daily-push] failed ... errcode=X errmsg=Y + throw（触发 BullMQ 重试）", async () => {
    mockGetSettings.mockResolvedValue({ webhook: VALID, enabled: true });
    mockDb.select.mockReturnValue(
      chainableMock([{ pickDate: "2026-07-19", composedImagePath: "/tmp/pick.jpg" }]),
    );
    mockSend.mockRejectedValue(new WeComRejectedError(93000, "invalid webhook url"));
    const job = makeJob();
    await expect(dailyPushWorker(job)).rejects.toThrow(/WECOM_REJECTED|93000/);
    const logs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain("[daily-push] failed");
    expect(logs).toContain("errcode=93000");
  });

  it("网络异常时输出 [daily-push] failed + throw（触发 BullMQ 重试）", async () => {
    mockGetSettings.mockResolvedValue({ webhook: VALID, enabled: true });
    mockDb.select.mockReturnValue(
      chainableMock([{ pickDate: "2026-07-19", composedImagePath: "/tmp/pick.jpg" }]),
    );
    mockSend.mockRejectedValue(new Error("ECONNRESET"));
    const job = makeJob();
    await expect(dailyPushWorker(job)).rejects.toThrow(/ECONNRESET/);
    const logs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain("[daily-push] failed");
  });
});

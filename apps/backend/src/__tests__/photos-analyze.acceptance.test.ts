/**
 * 验收测试：POST /api/photos/analyze — 跳过逻辑 + skippedCount 响应
 *
 * 覆盖：
 * - 默认行为（不传 force）：跳过已分析照片，返回 skippedCount
 * - force=true：重新分析所有照片，skippedCount=0
 * - 部分已分析场景：正确计算 skippedCount
 */
import { describe, expect, it, vi } from "vitest";

let mockQueryResult: unknown[] = [];

function chainableMock(result: unknown[] = []) {
  const fn = () => chainableMock(result);
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => resolve(mockQueryResult);
      }
      if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") {
        return () => "[]";
      }
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        return mockQueryResult[Number(prop)];
      }
      return chainableMock(result);
    },
  });
}

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../db", () => ({
  db: mockDb,
  schema: chainableMock([]),
}));

vi.mock("../jobs/queues", () => ({
  scanQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
  analyzeQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
  dailyQueue: { add: () => Promise.resolve({ id: "mock-job-id" }) },
}));

import { createApp } from "../app";

function app() {
  return createApp();
}

async function post(path: string, data?: unknown) {
  const res = await app().request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await res.json();
  return { status: res.status, body };
}

describe("POST /api/photos/analyze", () => {
  const validPhotoIds = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
  ];

  it("默认行为：不传 force，所有照片未分析时全部入队", async () => {
    // 模拟：所有 photoIds 都存在
    mockDb.select.mockReturnValue(chainableMock([]));
    // photoAnalyses 查询结果为空（所有都未分析）
    mockQueryResult = validPhotoIds.map((id) => ({ id }));

    // 第一次 select: 验证照片存在 → 返回所有存在
    // 第二次 select: 查 photoAnalyses → 返回空
    mockDb.select.mockReturnValue(chainableMock([]));

    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // 第一次查询：验证照片存在
        mockQueryResult = validPhotoIds.map((id) => ({ id }));
        return chainableMock([]);
      }
      // 第二次查询：查 photoAnalyses
      mockQueryResult = [];
      return chainableMock([]);
    });

    const { status, body } = await post("/api/photos/analyze", { photoIds: validPhotoIds });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    // 验证响应包含 skippedCount
    expect(body.data).toBeDefined();
    expect(typeof body.data.skippedCount).toBe("number");
  });

  it("不传 force 时跳过已分析照片，返回 skippedCount", async () => {
    // 模拟：3 张照片都存在，其中 1 张已分析
    const analyzedPhotoId = validPhotoIds[0];

    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // 验证照片存在：全部存在
        mockQueryResult = validPhotoIds.map((id) => ({ id }));
      } else {
        // photoAnalyses 查询：只有 1 张已分析
        mockQueryResult = [{ photoId: analyzedPhotoId }];
      }
      return chainableMock([]);
    });

    const { status, body } = await post("/api/photos/analyze", { photoIds: validPhotoIds });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.enqueued).toBe(2); // 3 - 1 = 2
    expect(body.data.skippedCount).toBe(1);
  });

  it("force=true 时不跳过已分析照片，skippedCount=0", async () => {
    // 模拟：3 张照片都存在，1 张已分析，但 force=true 全部入队
    const analyzedPhotoId = validPhotoIds[0];

    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        mockQueryResult = validPhotoIds.map((id) => ({ id }));
      } else {
        mockQueryResult = [{ photoId: analyzedPhotoId }];
      }
      return chainableMock([]);
    });

    const { status, body } = await post("/api/photos/analyze", {
      photoIds: validPhotoIds,
      force: true,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.enqueued).toBe(3); // 全部入队
    expect(body.data.skippedCount).toBe(0);
  });

  it("force=false 时跳过已分析照片", async () => {
    const analyzedPhotoId = validPhotoIds[0];

    let callCount = 0;
    mockDb.select.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        mockQueryResult = validPhotoIds.map((id) => ({ id }));
      } else {
        mockQueryResult = [{ photoId: analyzedPhotoId }];
      }
      return chainableMock([]);
    });

    const { status, body } = await post("/api/photos/analyze", {
      photoIds: validPhotoIds,
      force: false,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.enqueued).toBe(2);
    expect(body.data.skippedCount).toBe(1);
  });

  it("请求体为空时返回 400", async () => {
    const { status, body } = await post("/api/photos/analyze", undefined);

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  it("photoIds 为空数组时返回 400", async () => {
    const { status, body } = await post("/api/photos/analyze", { photoIds: [] });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  it("photoIds 中所有照片都不存在时返回 400", async () => {
    // 模拟照片都不存在
    mockQueryResult = [];
    mockDb.select.mockReturnValue(chainableMock([]));

    const { status, body } = await post("/api/photos/analyze", { photoIds: validPhotoIds });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe("所有照片都不存在");
  });
});

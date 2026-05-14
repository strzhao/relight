/**
 * 验收测试：PersonStrip 组件 SSR 渲染契约（红队，jsdom + renderToString）
 *
 * 设计契约（state.md「设计文档 → 模块划分」+「验收场景 A4」+「Plan Reviewer 修订 v2 #10」）：
 *
 *   PersonStrip 组件:
 *     - 路径：apps/web/components/person-strip.tsx
 *     - props:
 *         - storageSourceId: string
 *         - persons?: Person[]（可选；优先 props，fallback 内部 fetch）
 *         - onPersonClick?: (person: Person) => void
 *
 *     - 当 persons 含 displayable=true 数据 → 渲染圆形头像列表
 *     - 头像 src 应指向 GET /api/persons/:id/avatar.jpg（契约规约 avatarImage）
 *     - aria-label 显示 person.name；name=null 时显示 "人物 #xxxx"（id 前 4 位）
 *     - 头像被点击 → 调用 onPersonClick（实测通过 onClick 属性出现验证 SSR 串）
 *
 *   空数据：persons=[] → 不渲染 strip（或渲染空容器但不含 avatar 节点）
 *
 * 红队铁律：本文件不读 person-strip.tsx / person-edit-dialog.tsx 实现。
 *
 * 运行环境：jsdom（apps/web vitest.config.ts 指定 environment: 'jsdom'）。
 * 渲染策略：react-dom/server.renderToString 静态渲染，对 HTML 串做断言（与 photo-card-video 同模式）。
 */
import type { Person } from "@relight/shared";
import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- mock @/lib/api（PersonStrip 内部如调用 fetch，会经此层）----

vi.mock("@/lib/api", () => ({
  getPersons: vi.fn(),
  api: {
    persons: {
      list: vi.fn(),
      detail: vi.fn(),
    },
  },
  getApiUrl: vi.fn((path: string) => path),
}));

// ---- mock 数据工厂 ----

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: "p-deadbeef-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    storageSourceId: "src-001",
    name: "张三",
    nickname: null,
    bio: null,
    representativeFaceId: "f-1",
    avatarPath: ".persons/avatars/auto/p-1.jpg",
    customAvatarPath: null,
    memberCount: 50,
    manualOverride: false,
    displayable: true,
    hidden: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---- 渲染辅助 ----

async function renderStrip(props: {
  storageSourceId: string;
  persons?: Person[];
}): Promise<string> {
  const mod = (await import("@/components/person-strip")) as Record<string, unknown>;
  const PersonStrip = mod.PersonStrip ?? mod.default;
  if (typeof PersonStrip !== "function") {
    throw new Error(
      "PersonStrip component should be exported as named export `PersonStrip` or default export",
    );
  }
  return renderToString(
    React.createElement(PersonStrip as React.ComponentType<typeof props>, props),
  );
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =========================================================================
// 1. 组件存在性 + 接受 storageSourceId prop
// =========================================================================

describe("PersonStrip — 组件契约", () => {
  it("@/components/person-strip 应导出 PersonStrip 组件（命名或 default 导出均可）", async () => {
    const mod = (await import("@/components/person-strip")) as Record<string, unknown>;
    const PersonStrip = mod.PersonStrip ?? mod.default;
    expect(typeof PersonStrip).toBe("function");
  });

  it("接受 storageSourceId + persons prop 渲染不抛", async () => {
    await expect(
      renderStrip({ storageSourceId: "src-001", persons: [makePerson()] }),
    ).resolves.not.toThrow();
  });

  it("接受空 persons → 渲染不抛", async () => {
    await expect(renderStrip({ storageSourceId: "src-001", persons: [] })).resolves.not.toThrow();
  });
});

// =========================================================================
// 2. 头像列表渲染
// =========================================================================

describe("PersonStrip — 头像列表渲染", () => {
  it("3 个 displayable=true 的 person → 渲染 3 个头像（img 或 button 节点出现 3 次）", async () => {
    const persons = [
      makePerson({ id: "p-1111-aaaaaaaa", name: "奶奶" }),
      makePerson({ id: "p-2222-bbbbbbbb", name: "爷爷" }),
      makePerson({ id: "p-3333-cccccccc", name: "妈妈" }),
    ];
    const html = await renderStrip({ storageSourceId: "src-001", persons });

    // 3 个 person → HTML 中应出现 3 次 avatar.jpg URL（每个 person 一个 img.src）
    const matches = html.match(/\/api\/persons\/[^/]+\/avatar\.jpg/g);
    expect(matches).not.toBeNull();
    expect(matches?.length).toBeGreaterThanOrEqual(3);
  });

  it("头像 src 应指向 /api/persons/:id/avatar.jpg（契约规约 avatarImage）", async () => {
    const person = makePerson({ id: "p-deadbeef-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "张三" });
    const html = await renderStrip({ storageSourceId: "src-001", persons: [person] });
    expect(html).toContain("/api/persons/p-deadbeef-aaaa-aaaa-aaaa-aaaaaaaaaaaa/avatar.jpg");
  });

  it("有名字时 → aria-label 或可见文本应包含该名字", async () => {
    const person = makePerson({ id: "p-1111-aaaaaaaa", name: "奶奶" });
    const html = await renderStrip({ storageSourceId: "src-001", persons: [person] });
    // 设计契约：hover/aria-label 显示 person.name（场景 D）
    expect(html).toContain("奶奶");
  });

  it("name=null 时 → 显示 '人物 #xxxx' 占位（xxxx = id 前 4 位）", async () => {
    const person = makePerson({
      id: "1234abcd-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      name: null,
    });
    const html = await renderStrip({ storageSourceId: "src-001", persons: [person] });
    // 契约规约：未命名 person 渲染为「人物 #1234」
    expect(html).toContain("人物");
    expect(html).toContain("1234");
  });

  it("name=null 时 → 不应渲染裸 'null' 字符串", async () => {
    const person = makePerson({ id: "p-aaaa-bbbb-cccc-dddd", name: null });
    const html = await renderStrip({ storageSourceId: "src-001", persons: [person] });
    // 容易踩坑：React 渲染 {person.name} 在 null 时不会输出 'null'，
    // 但若 .toString() 被错误调用会输出 'null'，这里 negative-check
    expect(html).not.toMatch(/>\s*null\s*</);
  });
});

// =========================================================================
// 3. 空状态
// =========================================================================

describe("PersonStrip — 空状态", () => {
  it("persons=[] → HTML 中不应出现 avatar.jpg 链接", async () => {
    const html = await renderStrip({ storageSourceId: "src-001", persons: [] });
    expect(html).not.toContain("/api/persons/");
  });
});

// =========================================================================
// 4. 点击交互暴露（SSR 仅能验证 onClick attr 出现，行为由 e2e 验证）
// =========================================================================

describe("PersonStrip — 点击交互（SSR 静态校验）", () => {
  it("每个头像应渲染为可点击元素（button 或 a 或带 role='button' 的 div）", async () => {
    const person = makePerson({ id: "p-clickable", name: "张三" });
    const html = await renderStrip({ storageSourceId: "src-001", persons: [person] });
    // 设计：点击头像 → 触发 PersonEditDialog 打开
    // SSR 中 onClick 不会进入 HTML，需通过节点角色暗示交互性
    const isClickable =
      /<button[^>]*>[\s\S]*?\/api\/persons\/p-clickable\/avatar\.jpg/.test(html) ||
      /<a[^>]*>[\s\S]*?\/api\/persons\/p-clickable\/avatar\.jpg/.test(html) ||
      /role="button"[^>]*>[\s\S]*?\/api\/persons\/p-clickable\/avatar\.jpg/.test(html) ||
      // 反向：头像 img 在 <button>/<a>/role="button" 容器内
      /<button[^>]*>[\s\S]*?p-clickable[\s\S]*?<\/button>/.test(html) ||
      /<a[^>]*>[\s\S]*?p-clickable[\s\S]*?<\/a>/.test(html) ||
      /role="button"[\s\S]*?p-clickable/.test(html);
    expect(isClickable).toBe(true);
  });
});

// =========================================================================
// 5. 排序与过滤（依赖 props 数据，组件不应重新过滤 displayable=false）
// =========================================================================

describe("PersonStrip — 数据透传契约", () => {
  it("传入按 memberCount 排序的 persons → 渲染顺序应保持", async () => {
    // 服务端已按 memberCount desc 排序，组件不应再排
    // 注意：所有 person 都需 memberCount >= 20，否则会被「小 cluster 默认隐藏」规则过滤
    const persons = [
      makePerson({ id: "p-high", name: "高频", memberCount: 200 }),
      makePerson({ id: "p-mid", name: "中频", memberCount: 80 }),
      makePerson({ id: "p-low", name: "低频", memberCount: 25 }),
    ];
    const html = await renderStrip({ storageSourceId: "src-001", persons });

    // 三个名字按顺序出现
    const idxHigh = html.indexOf("高频");
    const idxMid = html.indexOf("中频");
    const idxLow = html.indexOf("低频");
    expect(idxHigh).toBeGreaterThanOrEqual(0);
    expect(idxMid).toBeGreaterThan(idxHigh);
    expect(idxLow).toBeGreaterThan(idxMid);
  });

  it("memberCount < 20 的 person 默认不应出现在 visible strip", async () => {
    // 契约：人脸聚类常产生大量低 memberCount 小群，顶部头像条只展示主要人物（>=20 张）
    const persons = [
      makePerson({ id: "p-big", name: "主要人物", memberCount: 100 }),
      makePerson({ id: "p-tiny-a", name: "小群A", memberCount: 19 }),
      makePerson({ id: "p-tiny-b", name: "小群B", memberCount: 5 }),
    ];
    const html = await renderStrip({ storageSourceId: "src-001", persons });

    expect(html).toContain("主要人物");
    expect(html).not.toContain("小群A");
    expect(html).not.toContain("小群B");
    expect(html).not.toContain("/api/persons/p-tiny-a/avatar.jpg");
    expect(html).not.toContain("/api/persons/p-tiny-b/avatar.jpg");
  });
});

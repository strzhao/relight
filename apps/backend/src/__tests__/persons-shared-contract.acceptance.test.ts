/**
 * 验收测试：@relight/shared 中 persons 相关 Zod Schema + 路由常量契约（红队）
 *
 * 设计契约（state.md 「契约规约 → Zod Schema 契约」+「API 路由常量契约」）：
 *
 * Zod Schema：
 *   updatePersonSchema:
 *     name: z.string().max(20).nullable().optional()  → null/""/省略均合法
 *     bio:  z.string().max(200).nullable().optional()
 *
 *   setPersonRepresentativeSchema:
 *     faceId: z.string().min(1)
 *
 *   mergePersonSchema:
 *     targetPersonId: z.string().min(1)
 *
 * 路由常量字面值（packages/shared/src/routes.ts）：
 *   API_ROUTES.persons.list                  === "/api/persons"
 *   API_ROUTES.persons.detail(id)            === `/api/persons/${id}`
 *   API_ROUTES.persons.update(id)            === `/api/persons/${id}`
 *   API_ROUTES.persons.representative(id)    === `/api/persons/${id}/representative`
 *   API_ROUTES.persons.merge(id)             === `/api/persons/${id}/merge`
 *   API_ROUTES.persons.avatarUpload(id)      === `/api/persons/${id}/avatar`
 *   API_ROUTES.persons.avatarImage(id)       === `/api/persons/${id}/avatar.jpg`
 *
 * 红队铁律：本文件不读 routes/persons.ts、shared 实现细节；只校验导出符号 + 字面字符串。
 *
 * 注意：shared 包没有独立 vitest workspace，本文件放在 backend 包以借用其 vitest 运行时。
 */
import { describe, expect, it } from "vitest";

// 不是直接 import，因为 import 顶层失败会让整个文件挂掉、看不到具体哪个契约缺失。
// 用动态 import + try 包裹，把"模块加载失败"也作为契约失败信号。
async function loadShared(): Promise<Record<string, unknown>> {
  const mod = (await import("@relight/shared")) as unknown as Record<string, unknown>;
  return mod;
}

// =========================================================================
// updatePersonSchema
// =========================================================================

describe("updatePersonSchema — Zod 契约", () => {
  it("应从 @relight/shared 导出", async () => {
    const shared = await loadShared();
    expect(shared.updatePersonSchema).toBeDefined();
  });

  it("接受 { name: '张三' } → safeParse success", async () => {
    const { updatePersonSchema } = (await loadShared()) as {
      updatePersonSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = updatePersonSchema.safeParse({ name: "张三" });
    expect(r.success).toBe(true);
  });

  it("接受 { name: null } → safeParse success（清空名字）", async () => {
    const { updatePersonSchema } = (await loadShared()) as {
      updatePersonSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = updatePersonSchema.safeParse({ name: null });
    expect(r.success).toBe(true);
  });

  it("接受 { name: '' } → safeParse success（空字符串视为清空）", async () => {
    const { updatePersonSchema } = (await loadShared()) as {
      updatePersonSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = updatePersonSchema.safeParse({ name: "" });
    expect(r.success).toBe(true);
  });

  it("接受 {}（全省略）→ safeParse success", async () => {
    const { updatePersonSchema } = (await loadShared()) as {
      updatePersonSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = updatePersonSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("拒绝 name 长度 21 → safeParse 失败", async () => {
    const { updatePersonSchema } = (await loadShared()) as {
      updatePersonSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = updatePersonSchema.safeParse({ name: "啊".repeat(21) });
    expect(r.success).toBe(false);
  });

  it("接受 name 长度 20（边界值）→ safeParse success", async () => {
    const { updatePersonSchema } = (await loadShared()) as {
      updatePersonSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = updatePersonSchema.safeParse({ name: "啊".repeat(20) });
    expect(r.success).toBe(true);
  });

  it("拒绝 bio 长度 201 → safeParse 失败", async () => {
    const { updatePersonSchema } = (await loadShared()) as {
      updatePersonSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = updatePersonSchema.safeParse({ bio: "x".repeat(201) });
    expect(r.success).toBe(false);
  });

  it("接受 bio 长度 200（边界值）→ safeParse success", async () => {
    const { updatePersonSchema } = (await loadShared()) as {
      updatePersonSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = updatePersonSchema.safeParse({ bio: "x".repeat(200) });
    expect(r.success).toBe(true);
  });

  it("接受 { bio: null } → safeParse success", async () => {
    const { updatePersonSchema } = (await loadShared()) as {
      updatePersonSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = updatePersonSchema.safeParse({ bio: null });
    expect(r.success).toBe(true);
  });

  it("拒绝 name=数字 → safeParse 失败（非 string）", async () => {
    const { updatePersonSchema } = (await loadShared()) as {
      updatePersonSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = updatePersonSchema.safeParse({ name: 123 });
    expect(r.success).toBe(false);
  });
});

// =========================================================================
// setPersonRepresentativeSchema
// =========================================================================

describe("setPersonRepresentativeSchema — Zod 契约", () => {
  it("应从 @relight/shared 导出", async () => {
    const shared = await loadShared();
    expect(shared.setPersonRepresentativeSchema).toBeDefined();
  });

  it("接受 { faceId: 'f-1' } → success", async () => {
    const { setPersonRepresentativeSchema } = (await loadShared()) as {
      setPersonRepresentativeSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = setPersonRepresentativeSchema.safeParse({ faceId: "f-1" });
    expect(r.success).toBe(true);
  });

  it("拒绝 {} (缺 faceId) → 失败", async () => {
    const { setPersonRepresentativeSchema } = (await loadShared()) as {
      setPersonRepresentativeSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = setPersonRepresentativeSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it("拒绝 { faceId: '' } → 失败（min(1)）", async () => {
    const { setPersonRepresentativeSchema } = (await loadShared()) as {
      setPersonRepresentativeSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = setPersonRepresentativeSchema.safeParse({ faceId: "" });
    expect(r.success).toBe(false);
  });

  it("拒绝 { faceId: null } → 失败", async () => {
    const { setPersonRepresentativeSchema } = (await loadShared()) as {
      setPersonRepresentativeSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = setPersonRepresentativeSchema.safeParse({ faceId: null });
    expect(r.success).toBe(false);
  });
});

// =========================================================================
// mergePersonSchema
// =========================================================================

describe("mergePersonSchema — Zod 契约", () => {
  it("应从 @relight/shared 导出", async () => {
    const shared = await loadShared();
    expect(shared.mergePersonSchema).toBeDefined();
  });

  it("接受 { targetPersonId: 'p-2' } → success", async () => {
    const { mergePersonSchema } = (await loadShared()) as {
      mergePersonSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = mergePersonSchema.safeParse({ targetPersonId: "p-2" });
    expect(r.success).toBe(true);
  });

  it("拒绝 {} (缺 targetPersonId) → 失败", async () => {
    const { mergePersonSchema } = (await loadShared()) as {
      mergePersonSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = mergePersonSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it("拒绝 { targetPersonId: '' } → 失败（min(1)）", async () => {
    const { mergePersonSchema } = (await loadShared()) as {
      mergePersonSchema: { safeParse: (v: unknown) => { success: boolean } };
    };
    const r = mergePersonSchema.safeParse({ targetPersonId: "" });
    expect(r.success).toBe(false);
  });
});

// =========================================================================
// API_ROUTES.persons 路由常量
// =========================================================================

describe("API_ROUTES.persons — 路由常量字面值", () => {
  it("应导出 API_ROUTES.persons", async () => {
    const { API_ROUTES } = (await loadShared()) as {
      API_ROUTES: { persons?: Record<string, unknown> };
    };
    expect(API_ROUTES.persons).toBeDefined();
  });

  it('persons.list === "/api/persons"', async () => {
    const { API_ROUTES } = (await loadShared()) as {
      API_ROUTES: { persons: { list: string } };
    };
    expect(API_ROUTES.persons.list).toBe("/api/persons");
  });

  it("persons.detail(id) === `/api/persons/${id}`", async () => {
    const { API_ROUTES } = (await loadShared()) as {
      API_ROUTES: { persons: { detail: (id: string) => string } };
    };
    expect(API_ROUTES.persons.detail("abc-123")).toBe("/api/persons/abc-123");
  });

  it("persons.update(id) === `/api/persons/${id}`（与 detail 同 path 但语义为 PATCH）", async () => {
    const { API_ROUTES } = (await loadShared()) as {
      API_ROUTES: { persons: { update: (id: string) => string } };
    };
    expect(API_ROUTES.persons.update("xyz")).toBe("/api/persons/xyz");
  });

  it("persons.representative(id) === `/api/persons/${id}/representative`", async () => {
    const { API_ROUTES } = (await loadShared()) as {
      API_ROUTES: { persons: { representative: (id: string) => string } };
    };
    expect(API_ROUTES.persons.representative("p-1")).toBe("/api/persons/p-1/representative");
  });

  it("persons.merge(id) === `/api/persons/${id}/merge`", async () => {
    const { API_ROUTES } = (await loadShared()) as {
      API_ROUTES: { persons: { merge: (id: string) => string } };
    };
    expect(API_ROUTES.persons.merge("p-1")).toBe("/api/persons/p-1/merge");
  });

  it("persons.avatarUpload(id) === `/api/persons/${id}/avatar`", async () => {
    const { API_ROUTES } = (await loadShared()) as {
      API_ROUTES: { persons: { avatarUpload: (id: string) => string } };
    };
    expect(API_ROUTES.persons.avatarUpload("p-1")).toBe("/api/persons/p-1/avatar");
  });

  it("persons.avatarImage(id) === `/api/persons/${id}/avatar.jpg`（修订 v2 引入）", async () => {
    const { API_ROUTES } = (await loadShared()) as {
      API_ROUTES: { persons: { avatarImage: (id: string) => string } };
    };
    expect(API_ROUTES.persons.avatarImage("p-1")).toBe("/api/persons/p-1/avatar.jpg");
  });

  it("avatarUpload 与 avatarImage 必须是不同 path（避免 GET/POST 二者撞车）", async () => {
    const { API_ROUTES } = (await loadShared()) as {
      API_ROUTES: {
        persons: {
          avatarUpload: (id: string) => string;
          avatarImage: (id: string) => string;
        };
      };
    };
    expect(API_ROUTES.persons.avatarUpload("p-1")).not.toBe(API_ROUTES.persons.avatarImage("p-1"));
  });
});

// =========================================================================
// TS Types 导出存在（Person/Face/PersonWithMembers）
// =========================================================================

describe("TS 类型契约 — types.ts 接口可在运行时间接验证（编译期已查）", () => {
  // TS 接口编译时擦除，运行时不可反查。这里通过"如下样本可类型化为 Person"做最小检查。
  // 真正的契约由 typecheck 阶段保证，本测试只确保 import 不会因为类型不存在而崩。
  it("@relight/shared 模块加载成功（间接断言 types.ts 编译通过）", async () => {
    const shared = await loadShared();
    expect(shared).toBeDefined();
    // 至少 schemas 和 routes 应共存（说明 index.ts barrel 完整）
    expect(shared.API_ROUTES).toBeDefined();
    expect(shared.updatePersonSchema).toBeDefined();
  });
});

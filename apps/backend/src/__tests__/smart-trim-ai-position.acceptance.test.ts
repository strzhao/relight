/**
 * 验收测试 T5.1：inferPosition 位置推断规则（红队）
 *
 * 覆盖契约：
 *   - C1: position="first" → skip（测试位置推断，skip 行为见 T5.7）
 *   - 设计文档"位置推断规则"伪代码（state.md inferPosition）
 *
 * 契约规约：
 *   inferPosition(fid, selection): "first" | "middle" | "closing"
 *   - selection 为 null → 所有 fid 返回 "middle"（保守）
 *   - selection.order 第 1 个 effective fid → "first"
 *   - selection.order 最后一个 effective fid → "closing"
 *   - W2 修复：排除 excluded fids 后才算 first/closing
 *   - 中间 fid → "middle"
 *   - order 为空数组 → 所有 fid 返回 "middle"（保守）
 *
 * 红队铁律：未读 smart-trim-ai.ts 实现；仅依据设计文档
 */
import { describe, expect, it } from "vitest";

// Selection 结构（来自 vlog 选片 selection.json）
interface Selection {
  order: string[];
  excluded?: string[];
  groups?: Record<string, string[]>;
}

type SmartTrimPosition = "first" | "middle" | "closing";

async function loadInferPosition(): Promise<
  (fid: string, selection: Selection | null) => SmartTrimPosition
> {
  const mod = await import("../cli/vlog/lib/smart-trim-ai");
  const fn = (mod as Record<string, unknown>).inferPosition;
  if (typeof fn !== "function") {
    throw new Error("smart-trim-ai.ts 必须导出 inferPosition 函数");
  }
  return fn as (fid: string, selection: Selection | null) => SmartTrimPosition;
}

describe("inferPosition 位置推断规则", () => {
  describe("导出契约", () => {
    it("smart-trim-ai 模块必须导出 inferPosition 函数", async () => {
      const mod = await import("../cli/vlog/lib/smart-trim-ai");
      expect(typeof (mod as Record<string, unknown>).inferPosition).toBe("function");
    });
  });

  describe("selection 为 null → 所有返回 middle（保守）", () => {
    it("selection=null 时任意 fid 返回 'middle'", async () => {
      const inferPosition = await loadInferPosition();
      expect(inferPosition("fid_001", null)).toBe("middle");
    });

    it("selection=null 时多个 fid 均返回 'middle'", async () => {
      const inferPosition = await loadInferPosition();
      expect(inferPosition("fid_002", null)).toBe("middle");
      expect(inferPosition("fid_003", null)).toBe("middle");
    });
  });

  describe("order 为空数组 → 所有 fid 返回 middle（保守）", () => {
    it("order=[] 时任意 fid 返回 'middle'", async () => {
      const inferPosition = await loadInferPosition();
      const selection: Selection = { order: [], excluded: [] };
      expect(inferPosition("fid_001", selection)).toBe("middle");
    });

    it("order=[] 且 excluded 非空 → 任意 fid 返回 'middle'", async () => {
      const inferPosition = await loadInferPosition();
      const selection: Selection = { order: [], excluded: ["fid_001"] };
      expect(inferPosition("fid_001", selection)).toBe("middle");
    });
  });

  describe("selection.order 第 1 个 effective fid → 'first'", () => {
    it("order 的第 1 个 fid（未排除）→ 'first'", async () => {
      const inferPosition = await loadInferPosition();
      const selection: Selection = {
        order: ["fid_001", "fid_002", "fid_003"],
        excluded: [],
      };
      expect(inferPosition("fid_001", selection)).toBe("first");
    });

    it("order 无 excluded 时，第 1 个 fid → 'first'", async () => {
      const inferPosition = await loadInferPosition();
      const selection: Selection = {
        order: ["alpha", "beta", "gamma"],
      };
      expect(inferPosition("alpha", selection)).toBe("first");
    });
  });

  describe("selection.order 最后一个 effective fid → 'closing'", () => {
    it("order 的最后一个 fid（未排除）→ 'closing'", async () => {
      const inferPosition = await loadInferPosition();
      const selection: Selection = {
        order: ["fid_001", "fid_002", "fid_003"],
        excluded: [],
      };
      expect(inferPosition("fid_003", selection)).toBe("closing");
    });

    it("order 无 excluded 时，最后一个 fid → 'closing'", async () => {
      const inferPosition = await loadInferPosition();
      const selection: Selection = {
        order: ["alpha", "beta", "gamma"],
      };
      expect(inferPosition("gamma", selection)).toBe("closing");
    });
  });

  describe("中间 fid → 'middle'", () => {
    it("order 的中间 fid 返回 'middle'", async () => {
      const inferPosition = await loadInferPosition();
      const selection: Selection = {
        order: ["fid_001", "fid_002", "fid_003", "fid_004", "fid_005"],
        excluded: [],
      };
      expect(inferPosition("fid_002", selection)).toBe("middle");
      expect(inferPosition("fid_003", selection)).toBe("middle");
      expect(inferPosition("fid_004", selection)).toBe("middle");
    });

    it("不在 order 中的 fid → 'middle'（保守兜底）", async () => {
      const inferPosition = await loadInferPosition();
      const selection: Selection = {
        order: ["fid_001", "fid_002", "fid_003"],
        excluded: [],
      };
      expect(inferPosition("fid_999", selection)).toBe("middle");
    });
  });

  describe("W2 修复：排除 excluded fids 后才算 first/closing", () => {
    it("第 1 个 fid 在 excluded 中，第 2 个 effective fid 为 'first'", async () => {
      const inferPosition = await loadInferPosition();
      const selection: Selection = {
        order: ["fid_001", "fid_002", "fid_003"],
        excluded: ["fid_001"],
      };
      // fid_001 排除后，有效顺序是 [fid_002, fid_003]，fid_002 是 first
      expect(inferPosition("fid_002", selection)).toBe("first");
    });

    it("最后一个 fid 在 excluded 中，倒数第 2 个 effective fid 为 'closing'", async () => {
      const inferPosition = await loadInferPosition();
      const selection: Selection = {
        order: ["fid_001", "fid_002", "fid_003"],
        excluded: ["fid_003"],
      };
      // fid_003 排除后，有效顺序是 [fid_001, fid_002]，fid_002 是 closing
      expect(inferPosition("fid_002", selection)).toBe("closing");
    });

    it("excluded 同时包含第 1 个和最后一个 fid → 中间 fid 的 first/closing 重新确定", async () => {
      const inferPosition = await loadInferPosition();
      const selection: Selection = {
        order: ["fid_001", "fid_002", "fid_003", "fid_004", "fid_005"],
        excluded: ["fid_001", "fid_005"],
      };
      // effective order: [fid_002, fid_003, fid_004]
      expect(inferPosition("fid_002", selection)).toBe("first");
      expect(inferPosition("fid_003", selection)).toBe("middle");
      expect(inferPosition("fid_004", selection)).toBe("closing");
    });

    it("所有 fid 都在 excluded 中（effective order 为空）→ 返回 'middle'", async () => {
      const inferPosition = await loadInferPosition();
      const selection: Selection = {
        order: ["fid_001", "fid_002"],
        excluded: ["fid_001", "fid_002"],
      };
      expect(inferPosition("fid_001", selection)).toBe("middle");
      expect(inferPosition("fid_002", selection)).toBe("middle");
    });

    it("被排除的 fid 本身调用 inferPosition → 返回 'middle'（排除的不是 effective）", async () => {
      const inferPosition = await loadInferPosition();
      const selection: Selection = {
        order: ["fid_001", "fid_002", "fid_003"],
        excluded: ["fid_001"],
      };
      // fid_001 虽在 order 中，但被 excluded，不是 effective first
      expect(inferPosition("fid_001", selection)).toBe("middle");
    });

    it("order 只有一个 effective fid → 既是 first 也是 closing（取 closing 或 first 任一合理实现均可，关键是不能返回 middle）", async () => {
      const inferPosition = await loadInferPosition();
      const selection: Selection = {
        order: ["fid_001", "fid_002"],
        excluded: ["fid_002"],
      };
      // effective order: [fid_001]，只有一个 fid
      const pos = inferPosition("fid_001", selection);
      // 根据设计文档伪代码：先判断 closing（最后一个），再判断 first（第一个）
      // 如果 effectiveOrder.length=1，closing 检查先执行，应返回 "closing"
      // 或者实现可能返回 "first"，取决于判断顺序
      // 红队不对这个 edge case 强断言，但不应返回 "middle"
      expect(["first", "closing"]).toContain(pos);
    });
  });
});

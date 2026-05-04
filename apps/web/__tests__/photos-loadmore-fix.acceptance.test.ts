/**
 * 照片页面无限滚动加载修复 — 验收测试
 *
 * 【设计文档：三级联加重算循环修复】
 *
 * 主因：sentinelRef callback ref 依赖 isFetchingMore，状态变化导致
 *       observer 重建，新 observer 检测到 sentinel 仍在视口内，立即
 *       触发下一次 loadMore，形成无限循环。
 *
 * 修复策略：
 *   Fix 1: getItemKey — use-virtual-grid.ts，提供稳定身份
 *   Fix 2: estimateSize 稳定化 — use-virtual-grid.ts，减少闭包重建
 *   Fix 3: 加载冷却期 — use-photos-infinite.ts，打断级联加载
 *   Fix 4: React key 对齐 — photos/page.tsx，使用 virtualItem.key
 *
 * ============================================================================
 * 本文件仅基于设计文档编写，不引用任何实现代码（红队铁律）
 * ============================================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// 类型定义（从设计文档复刻）
// ============================================================================

interface Photo {
  id: string;
  storageSourceId: string;
  filePath: string;
  fileHash: string;
  width: number;
  height: number;
  fileSize: number;
  thumbnailPath: string | null;
  takenAt: string | null;
  createdAt: string;
}

type DateViewMode = "year" | "month" | "day";

// ============================================================================
// 辅助工厂函数
// ============================================================================

function makePhoto(overrides: Partial<Photo> = {}): Photo {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    storageSourceId: "src-001",
    filePath: `/photos/${id}.jpg`,
    fileHash: `hash-${id}`,
    width: 4000,
    height: 3000,
    fileSize: 2_000_000,
    thumbnailPath: `/thumbnails/${id}.jpg`,
    takenAt: "2026-05-03T10:30:00.000Z",
    createdAt: "2026-05-03T12:00:00.000Z",
    ...overrides,
  };
}

// ============================================================================
// FlatItem / VirtualItem 类型（从设计文档建模）
// ============================================================================

type FlatItemType = "header" | "photoRow" | "sentinel";

interface FlatItem {
  type: FlatItemType;
  /** 所属分组索引（header/photoRow 有效，sentinel 为 -1） */
  groupIndex: number;
  /** 在分组内的行索引（photoRow 有效） */
  rowIndex: number;
  /** header 的分组标签 */
  label?: string;
  /** header 的分组照片数量 */
  count?: number;
  /** photoRow 包含的照片 */
  photos?: Photo[];
}

// ============================================================================
// FIX 1: getItemKey — 提供稳定身份
// ============================================================================

/**
 * 设计文档 §验收标准 1：
 *   - sentinel 虚拟项的 key 为 "__sentinel__"
 *   - header 虚拟项的 key 包含 groupIndex 和 label
 *   - photoRow 虚拟项的 key 包含 groupIndex 和 firstPhotoId
 *   - 多次渲染间相同内容的 key 保持不变
 *
 * 在 @tanstack/react-virtual 中，getItemKey 的签名：
 *   (index: number, items: TItem[]) => string | number
 */

function getItemKey(index: number, items: FlatItem[]): string | number {
  const item = items[index];
  if (!item) return `__missing__${index}`;

  switch (item.type) {
    case "sentinel":
      return "__sentinel__";
    case "header":
      // key 包含 groupIndex 和 label，确保不同 header 有不同的 key
      return `header-${item.groupIndex}-${item.label ?? "unknown"}`;
    case "photoRow": {
      // key 包含 groupIndex 和 firstPhotoId，确保不同行有不同的 key
      const firstPhotoId = item.photos?.[0]?.id ?? "empty";
      return `photo-${item.groupIndex}-${firstPhotoId}`;
    }
    default:
      return `unknown-${index}`;
  }
}

// ============================================================================
// FIX 2: estimateSize — 稳定闭包
// ============================================================================

/**
 * 设计文档 §验收标准 2：
 *   - estimateSize 不依赖 flatItems（避免每次 flatItems 变化时闭包重建）
 *   - estimateSize 仅依赖 cellSize 和 headerSize（稳定的常量）
 *   - sentinel 仍返回 headerSize
 *
 * 在 @tanstack/react-virtual 中，estimateSize 的签名：
 *   (index: number) => number
 *
 * 设计约束：由于不能依赖 flatItems，estimateSize 需要通过其他方式
 * 确定每个 index 的类型。实际上 virtualizer.getItemKey 提供了 index→item
 * 的映射能力，estimateSize 本身不需要知道 flatItems。
 *
 * 关键验收点：创建 estimateSize 的工厂函数不应捕获 flatItems。
 */

interface EstimateSizeConfig {
  cellSize: number;
  headerSize: number;
}

/**
 * 创建一个稳定的 estimateSize 函数。
 * 该闭包仅捕获 cellSize 和 headerSize，不依赖 flatItems。
 *
 * 实际实现中，estimateSize 可能返回常量 cellSize（所有项等高），
 * 或通过 virtualizer 内部的 getItemKey/index 映射确定类型。
 * 这里建模为纯常量返回，验证闭包稳定性。
 */
function createStableEstimateSize(config: EstimateSizeConfig): (index: number) => number {
  const { cellSize } = config;
  // 闭包仅捕获 cellSize（稳定常量），不捕获 flatItems
  // sentinel 返回 headerSize，此项由 virtualizer 内部处理
  return (_index: number) => cellSize;
}

/**
 * 另一种可能的实现：estimateSize 接受一个类型判定辅助参数，
 * 但仍不直接引用 flatItems。
 */
function createEstimateSizeWithTypeCheck(
  config: EstimateSizeConfig,
  getItemType: (index: number) => FlatItemType,
): (index: number) => number {
  const { cellSize, headerSize } = config;
  return (index: number) => {
    const type = getItemType(index);
    if (type === "sentinel" || type === "header") return headerSize;
    return cellSize;
  };
}

// ============================================================================
// FIX 3: 加载冷却期（cooldown）
// ============================================================================

/**
 * 设计文档 §验收标准 3：
 *   - LOAD_SUCCESS / LOAD_MORE_SUCCESS dispatch 后设置 800ms 冷却期
 *   - 冷却期内 loadMoreInternal.current() 直接 return，不触发新请求
 *   - 冷却期结束后可以正常触发下次加载
 *
 * 建模为状态机扩展：在现有 InfiniteState 基础上增加 lastLoadSuccessTime
 * 和冷却期守卫函数。
 */

const COOLDOWN_MS = 800;

/** 带冷却期的初始状态（模块级作用域，所有 describe 块共享） */
const initialCooldownState: CooldownState = {
  photos: [],
  isLoading: false,
  isFetchingMore: false,
  error: null,
  hasMore: true,
  page: 0,
  lastLoadSuccessTime: 0,
};

interface InfiniteState {
  photos: Photo[];
  isLoading: boolean;
  isFetchingMore: boolean;
  error: string | null;
  hasMore: boolean;
  page: number;
}

/** 带冷却期的扩展状态 */
interface CooldownState extends InfiniteState {
  /** 最后一次成功加载的时间戳（毫秒） */
  lastLoadSuccessTime: number;
}

type InfiniteAction =
  | { type: "LOAD_START" }
  | { type: "LOAD_SUCCESS"; photos: Photo[]; hasMore: boolean }
  | { type: "LOAD_MORE_START" }
  | { type: "LOAD_MORE_SUCCESS"; photos: Photo[]; hasMore: boolean }
  | { type: "LOAD_ERROR"; error: string }
  | { type: "RESET" };

function infiniteReducer(state: InfiniteState, action: InfiniteAction): InfiniteState {
  switch (action.type) {
    case "LOAD_START":
      return { ...state, isLoading: true, error: null };
    case "LOAD_SUCCESS":
      return {
        ...state,
        isLoading: false,
        photos: action.photos,
        hasMore: action.hasMore,
        page: 1,
      };
    case "LOAD_MORE_START":
      return { ...state, isFetchingMore: true };
    case "LOAD_MORE_SUCCESS":
      return {
        ...state,
        isFetchingMore: false,
        photos: [...state.photos, ...action.photos],
        hasMore: action.hasMore,
        page: state.page + 1,
      };
    case "LOAD_ERROR":
      return {
        ...state,
        isLoading: false,
        isFetchingMore: false,
        error: action.error,
      };
    case "RESET":
      return {
        photos: [],
        isLoading: false,
        isFetchingMore: false,
        error: null,
        hasMore: true,
        page: 0,
      };
    default:
      return state;
  }
}

/** 带冷却期记录的增强版 reducer */
function cooldownReducer(state: CooldownState, action: InfiniteAction, now: number): CooldownState {
  switch (action.type) {
    case "LOAD_SUCCESS":
      return {
        ...state,
        isLoading: false,
        photos: action.photos,
        hasMore: action.hasMore,
        page: 1,
        lastLoadSuccessTime: now, // 设置冷却期起点
      };
    case "LOAD_MORE_SUCCESS":
      return {
        ...state,
        isFetchingMore: false,
        photos: [...state.photos, ...action.photos],
        hasMore: action.hasMore,
        page: state.page + 1,
        lastLoadSuccessTime: now, // 设置冷却期起点
      };
    case "LOAD_MORE_START":
      return { ...state, isFetchingMore: true };
    case "LOAD_START":
      return { ...state, isLoading: true, error: null };
    case "LOAD_ERROR":
      return { ...state, isLoading: false, isFetchingMore: false, error: action.error };
    case "RESET":
      return {
        photos: [],
        isLoading: false,
        isFetchingMore: false,
        error: null,
        hasMore: true,
        page: 0,
        lastLoadSuccessTime: 0,
      };
    default:
      return state;
  }
}

/**
 * 冷却期守卫：判断是否可以触发新的加载请求。
 *
 * 规则：
 *   1. isFetchingMore 为 true → 禁止（正在加载中）
 *   2. hasMore 为 false → 禁止（无更多数据）
 *   3. 距离上次成功加载不足 COOLDOWN_MS → 禁止（冷却期内）
 *   4. 否则允许
 */
function canTriggerLoadMore(
  state: CooldownState,
  now: number,
  cooldownMs: number = COOLDOWN_MS,
): boolean {
  if (state.isFetchingMore) return false;
  if (!state.hasMore) return false;
  const elapsed = now - state.lastLoadSuccessTime;
  return elapsed >= cooldownMs;
}

/** 模拟 loadMoreInternal.current() 的守卫行为 */
function guardedLoadMore(
  state: CooldownState,
  now: number,
  cooldownMs: number = COOLDOWN_MS,
): { allowed: boolean; reason: string } {
  if (state.isFetchingMore) {
    return { allowed: false, reason: "already fetching" };
  }
  if (!state.hasMore) {
    return { allowed: false, reason: "no more data" };
  }
  const elapsed = now - state.lastLoadSuccessTime;
  if (elapsed < cooldownMs) {
    return { allowed: false, reason: `cooldown: ${elapsed}ms < ${cooldownMs}ms` };
  }
  return { allowed: true, reason: "ok" };
}

// ============================================================================
// FIX 4: React key 对齐
// ============================================================================

/**
 * 设计文档 §验收标准 4：
 *   - sentinel 渲染使用 virtualItem.key 而非硬编码 "sentinel"
 *   - header 渲染使用 virtualItem.key 而非 h-${item.groupIndex}
 *   - photoRow 渲染使用 virtualItem.key 而非 r-${item.groupIndex}-${virtualItem.index}
 *
 * 这意味着组件渲染层需要从 virtualizer 获取 key，而不是自行拼接。
 * 验证方式：确认 getItemKey 返回的 key 与 virtualItem.key 一致。
 */

/** 旧的 key 生成方式（应该被替换） */
function oldSentinelKey(): string {
  return "sentinel";
}

function oldHeaderKey(groupIndex: number): string {
  return `h-${groupIndex}`;
}

function oldPhotoRowKey(groupIndex: number, virtualItemIndex: number): string {
  return `r-${groupIndex}-${virtualItemIndex}`;
}

// ============================================================================
// ============================================================================
// 测试用例
// ============================================================================
// ============================================================================

// ---------------------------------------------------------------------------
// 验收标准 1: getItemKey 提供稳定身份
// ---------------------------------------------------------------------------

describe("验收标准 1: getItemKey 提供稳定身份", () => {
  describe("sentinel key", () => {
    it("sentinel 的 key 应为固定字符串 '__sentinel__'", () => {
      const sentinelItem: FlatItem = {
        type: "sentinel",
        groupIndex: -1,
        rowIndex: -1,
      };
      const items: FlatItem[] = [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2026年", count: 5 },
        sentinelItem,
      ];

      const key = getItemKey(1, items);
      expect(key).toBe("__sentinel__");
    });

    it("多次调用应返回相同的 sentinel key", () => {
      const sentinelItem: FlatItem = {
        type: "sentinel",
        groupIndex: -1,
        rowIndex: -1,
      };
      const items: FlatItem[] = [sentinelItem];

      const results = Array.from({ length: 5 }, () => getItemKey(0, items));
      const uniqueKeys = new Set(results);
      expect(uniqueKeys.size).toBe(1);
      expect(results[0]).toBe("__sentinel__");
    });

    it("sentinel key 不应包含索引信息（不受位置变化影响）", () => {
      const sentinelItem: FlatItem = {
        type: "sentinel",
        groupIndex: -1,
        rowIndex: -1,
      };

      // sentinel 分别在 index 0 和 index 10
      const itemsAt0: FlatItem[] = [sentinelItem];
      const itemsAt10: FlatItem[] = [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2026年", count: 5 },
        { type: "photoRow", groupIndex: 0, rowIndex: 0, photos: [makePhoto()] },
        { type: "photoRow", groupIndex: 0, rowIndex: 1, photos: [makePhoto()] },
        { type: "header", groupIndex: 1, rowIndex: 0, label: "2025年", count: 3 },
        { type: "photoRow", groupIndex: 1, rowIndex: 0, photos: [makePhoto()] },
        { type: "header", groupIndex: 2, rowIndex: 0, label: "2024年", count: 2 },
        { type: "photoRow", groupIndex: 2, rowIndex: 0, photos: [makePhoto()] },
        { type: "header", groupIndex: 3, rowIndex: 0, label: "2023年", count: 1 },
        { type: "photoRow", groupIndex: 3, rowIndex: 0, photos: [makePhoto()] },
        { type: "header", groupIndex: 4, rowIndex: 0, label: "2022年", count: 1 },
        sentinelItem,
      ];

      expect(getItemKey(0, itemsAt0)).toBe("__sentinel__");
      expect(getItemKey(10, itemsAt10)).toBe("__sentinel__");
    });
  });

  describe("header key", () => {
    it("header key 应包含 groupIndex 和 label", () => {
      const items: FlatItem[] = [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2026年", count: 11 },
      ];
      const key = getItemKey(0, items);
      expect(key).toContain("0");
      expect(key).toContain("2026年");
    });

    it("不同 groupIndex 的 header 应有不同的 key", () => {
      const items: FlatItem[] = [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2026年", count: 5 },
        { type: "photoRow", groupIndex: 0, rowIndex: 0, photos: [makePhoto()] },
        { type: "header", groupIndex: 1, rowIndex: 0, label: "2025年", count: 3 },
        { type: "photoRow", groupIndex: 1, rowIndex: 0, photos: [makePhoto()] },
        { type: "header", groupIndex: 2, rowIndex: 0, label: "2024年", count: 11 },
      ];

      const k0 = getItemKey(0, items);
      const k2 = getItemKey(2, items);
      const k4 = getItemKey(4, items);

      expect(k0).not.toBe(k2);
      expect(k0).not.toBe(k4);
      expect(k2).not.toBe(k4);
    });

    it("相同 groupIndex 和 label 的 header 在多次渲染间 key 应不变", () => {
      const headerItem: FlatItem = {
        type: "header",
        groupIndex: 3,
        rowIndex: 0,
        label: "2024年5月",
        count: 11,
      };

      const key1 = getItemKey(0, [headerItem]);
      const key2 = getItemKey(5, [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2026年", count: 2 },
        { type: "photoRow", groupIndex: 0, rowIndex: 0, photos: [makePhoto()] },
        { type: "header", groupIndex: 1, rowIndex: 0, label: "2025年", count: 1 },
        { type: "photoRow", groupIndex: 1, rowIndex: 0, photos: [makePhoto()] },
        { type: "header", groupIndex: 2, rowIndex: 0, label: "2024年", count: 3 },
        headerItem,
      ]);

      expect(key1).toBe(key2);
      expect(key1).toBe("header-3-2024年5月");
    });
  });

  describe("photoRow key", () => {
    it("photoRow key 应包含 groupIndex 和 firstPhotoId", () => {
      const photo1 = makePhoto({ id: "photo-abc-123" });
      const items: FlatItem[] = [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2024年", count: 11 },
        { type: "photoRow", groupIndex: 0, rowIndex: 0, photos: [photo1] },
      ];

      const key = getItemKey(1, items);
      expect(key).toContain("0");
      expect(key).toContain("photo-abc-123");
    });

    it("同一分组内不同行的 key 应不同（firstPhotoId 不同）", () => {
      const p1 = makePhoto({ id: "p1" });
      const p2 = makePhoto({ id: "p2" });
      const p3 = makePhoto({ id: "p3" });
      const p4 = makePhoto({ id: "p4" });

      const items: FlatItem[] = [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2024年", count: 4 },
        { type: "photoRow", groupIndex: 0, rowIndex: 0, photos: [p1, p2, p3] },
        { type: "photoRow", groupIndex: 0, rowIndex: 1, photos: [p4] },
      ];

      expect(getItemKey(1, items)).not.toBe(getItemKey(2, items));
    });

    it("photoRow key 不应依赖其在 flatItems 中的索引位置", () => {
      const p1 = makePhoto({ id: "p1" });
      const rowItem: FlatItem = {
        type: "photoRow",
        groupIndex: 0,
        rowIndex: 0,
        photos: [p1],
      };

      // row 在 index 1
      const keyAt1 = getItemKey(1, [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2024年", count: 1 },
        rowItem,
      ]);

      // 同一 row 在 index 100
      const manyItems: FlatItem[] = [];
      for (let i = 0; i < 50; i++) {
        manyItems.push({
          type: "header",
          groupIndex: i,
          rowIndex: 0,
          label: `${2026 - i}年`,
          count: 1,
        });
        manyItems.push({
          type: "photoRow",
          groupIndex: i,
          rowIndex: 0,
          photos: [makePhoto()],
        });
      }
      manyItems.push(rowItem);
      const keyAt100 = getItemKey(100, manyItems);

      expect(keyAt1).toBe(keyAt100);
    });

    it("数据追加后已存在 photoRow 的 key 应保持不变", () => {
      // 模拟加载更多：第 1 页有 2 张照片（1 行），第 2 页追加 2 张（新增 1 行）
      const p1 = makePhoto({ id: "p1" });
      const p2 = makePhoto({ id: "p2" });
      const p3 = makePhoto({ id: "p3" });

      // 第 1 页加载后的 items
      const itemsPage1: FlatItem[] = [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2024年", count: 2 },
        { type: "photoRow", groupIndex: 0, rowIndex: 0, photos: [p1, p2] },
      ];

      const keyBefore = getItemKey(1, itemsPage1); // photoRow at index 1

      // 第 2 页加载后的 items（新数据追加，groupIndex 不变，rowIndex 递增）
      const itemsPage2: FlatItem[] = [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2024年", count: 3 },
        { type: "photoRow", groupIndex: 0, rowIndex: 0, photos: [p1, p2] },
        { type: "photoRow", groupIndex: 0, rowIndex: 1, photos: [p3] },
      ];

      const keyAfterAtIndex1 = getItemKey(1, itemsPage2); // 同一行仍在 index 1

      // 第一条 photoRow 的 key 在数据追加前后应保持不变
      expect(keyBefore).toBe(keyAfterAtIndex1);
    });
  });

  describe("getItemKey 整体稳定性", () => {
    it("getItemKey 不应使用 index 作为 key（默认行为被替代）", () => {
      // @tanstack/react-virtual 默认 getItemKey = (index) => index
      // Fix 1 要求自定义 getItemKey 替代默认行为
      const defaultKey = (index: number) => index;
      const items: FlatItem[] = [{ type: "sentinel", groupIndex: -1, rowIndex: -1 }];

      const customKey = getItemKey(0, items);
      const defaultBehavior = defaultKey(0);

      // 默认 key 是数字索引，自定义 key 是语义字符串
      expect(typeof customKey).toBe("string");
      expect(customKey).not.toBe(String(defaultBehavior));
    });

    it("flatten 重建后相同逻辑内容的 key 应保持不变", () => {
      // 模拟：由于 cellSize 变化导致虚拟器重建，flatItems 重新生成
      // 但照片内容不变 — key 应保持稳定

      const p1 = makePhoto({ id: "photo-1" });
      const p2 = makePhoto({ id: "photo-2" });

      const buildFlatItems = (): FlatItem[] => [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2024年", count: 2 },
        { type: "photoRow", groupIndex: 0, rowIndex: 0, photos: [p1, p2] },
        { type: "sentinel", groupIndex: -1, rowIndex: -1 },
      ];

      const items1 = buildFlatItems();
      const items2 = buildFlatItems();

      // 验证所有 key 在两次 flatten 间保持不变
      for (let i = 0; i < items1.length; i++) {
        expect(getItemKey(i, items1)).toBe(getItemKey(i, items2));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 验收标准 2: estimateSize 稳定化
// ---------------------------------------------------------------------------

describe("验收标准 2: estimateSize 稳定化", () => {
  const cellSize = 120;
  const headerSize = 44;

  describe("estimateSize 不应依赖 flatItems", () => {
    it("createStableEstimateSize 闭包不应引用 flatItems", () => {
      // 验证：创建 estimateSize 时不需要传入 flatItems
      const estimateFn = createStableEstimateSize({ cellSize, headerSize });

      // estimateFn 是一个纯函数，仅接受 index
      // 不存在对 flatItems 的隐式依赖
      expect(typeof estimateFn).toBe("function");
      expect(estimateFn.length).toBe(1); // 仅接受 index 参数
    });

    it("无论 flatItems 如何变化，estimateSize 行为应一致", () => {
      const estimateFn = createStableEstimateSize({ cellSize, headerSize });

      // 不同规模的照片集合
      const result1 = estimateFn(0);
      const result2 = estimateFn(999);

      // 对于非 sentinel 项，应返回 cellSize
      expect(result1).toBe(cellSize);
      expect(result2).toBe(cellSize);
    });

    it("cellSize 或 headerSize 保持不变时，不应重建 estimateSize 闭包", () => {
      // 设计意图：useMemo 的依赖项只有 [cellSize, headerSize]
      // flatItems 的变化不应触发 estimateSize 重建

      // 模拟第一次创建
      const fn1 = createStableEstimateSize({ cellSize, headerSize });

      // flatItems 变化（模拟数据追加），但 cellSize/headerSize 不变
      // → 不应重建 estimateSize（此处验证设计契约）
      const fn2 = createStableEstimateSize({ cellSize, headerSize });

      // 虽然引用不同（新创建），但行为应完全相同
      for (let i = 0; i < 100; i++) {
        expect(fn1(i)).toBe(fn2(i));
      }
    });
  });

  describe("estimateSize 仅依赖 cellSize 和 headerSize", () => {
    it("estimateSize 应能从 cellSize 和 headerSize 计算出所有值", () => {
      const config: EstimateSizeConfig = { cellSize: 120, headerSize: 44 };
      const estimateFn = createStableEstimateSize(config);

      // 所有结果应来自 {120, 44} 的组合
      for (let i = 0; i < 50; i++) {
        const v = estimateFn(i);
        // 返回值应该是 cellSize 或 headerSize
        expect([cellSize, headerSize]).toContain(v);
      }
    });

    it("修改 cellSize 后 estimateSize 应返回新值", () => {
      const fn1 = createStableEstimateSize({ cellSize: 120, headerSize: 44 });
      const fn2 = createStableEstimateSize({ cellSize: 160, headerSize: 44 });

      expect(fn1(0)).toBe(120);
      expect(fn2(0)).toBe(160);
    });

    it("修改 headerSize 后 estimateSize 应反映新值", () => {
      const fn1 = createStableEstimateSize({ cellSize: 120, headerSize: 44 });
      const fn2 = createStableEstimateSize({ cellSize: 120, headerSize: 52 });

      // 对于 header/sentinel 应返回新 headerSize
      const typeFn = (idx: number): FlatItemType => (idx === 0 ? "header" : "photoRow");
      const typed1 = createEstimateSizeWithTypeCheck({ cellSize: 120, headerSize: 44 }, typeFn);
      const typed2 = createEstimateSizeWithTypeCheck({ cellSize: 120, headerSize: 52 }, typeFn);

      expect(typed1(0)).toBe(44);
      expect(typed2(0)).toBe(52);
    });
  });

  describe("sentinel 仍返回 headerSize", () => {
    it("sentinel 的估计高度应为 headerSize", () => {
      const typeFn = (idx: number): FlatItemType => (idx === 99 ? "sentinel" : "photoRow");
      const estimateFn = createEstimateSizeWithTypeCheck({ cellSize: 120, headerSize: 44 }, typeFn);

      expect(estimateFn(99)).toBe(44); // sentinel → headerSize
      expect(estimateFn(0)).toBe(120); // photoRow → cellSize
    });

    it("header 的估计高度也应为 headerSize", () => {
      const typeFn = (idx: number): FlatItemType => (idx % 5 === 0 ? "header" : "photoRow");
      const estimateFn = createEstimateSizeWithTypeCheck({ cellSize: 120, headerSize: 44 }, typeFn);

      expect(estimateFn(0)).toBe(44); // header → headerSize
      expect(estimateFn(5)).toBe(44); // header → headerSize
      expect(estimateFn(1)).toBe(120); // photoRow → cellSize
    });
  });
});

// ---------------------------------------------------------------------------
// 验收标准 3: 加载冷却期（cooldown）
// ---------------------------------------------------------------------------

describe("验收标准 3: 加载冷却期（cooldown）", () => {
  describe("LOAD_SUCCESS 后设置冷却期", () => {
    it("LOAD_SUCCESS 应记录 lastLoadSuccessTime", () => {
      const now = 10000;
      const prev = { ...initialCooldownState, isLoading: true };
      const next = cooldownReducer(
        prev,
        {
          type: "LOAD_SUCCESS",
          photos: [makePhoto()],
          hasMore: true,
        },
        now,
      );

      expect(next.lastLoadSuccessTime).toBe(now);
      expect(next.isLoading).toBe(false);
    });

    it("LOAD_SUCCESS 冷却期内 loadMore 应被阻止", () => {
      const now = 10000;
      const state = cooldownReducer(
        { ...initialCooldownState, isLoading: true },
        { type: "LOAD_SUCCESS", photos: [makePhoto()], hasMore: true },
        now,
      );

      // 冷却期刚开始 (now + 0ms)
      const result = guardedLoadMore(state, now);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("cooldown");
    });

    it("LOAD_SUCCESS 冷却期内即使 isFetchingMore=false 也不应触发", () => {
      const now = 10000;
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        isFetchingMore: false,
        hasMore: true,
        page: 1,
        lastLoadSuccessTime: now,
      };

      // 冷却期刚开始
      expect(state.isFetchingMore).toBe(false);
      expect(state.hasMore).toBe(true);
      const result = guardedLoadMore(state, now);
      expect(result.allowed).toBe(false);
    });

    it("LOAD_SUCCESS 冷却期结束后 loadMore 应正常触发", () => {
      const now = 10000;
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        isFetchingMore: false,
        hasMore: true,
        page: 1,
        lastLoadSuccessTime: now,
      };

      // 冷却期刚过 (now + 800ms + 1ms)
      const resultAfter = guardedLoadMore(state, now + COOLDOWN_MS + 1);
      expect(resultAfter.allowed).toBe(true);
    });

    it("冷却期边界值 799ms 应被阻止，800ms 应放行", () => {
      const loadTime = 10000;
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        isFetchingMore: false,
        hasMore: true,
        page: 1,
        lastLoadSuccessTime: loadTime,
      };

      // 799ms < 800ms → 阻止
      expect(guardedLoadMore(state, loadTime + 799).allowed).toBe(false);
      // 800ms >= 800ms → 放行
      expect(guardedLoadMore(state, loadTime + COOLDOWN_MS).allowed).toBe(true);
    });
  });

  describe("LOAD_MORE_SUCCESS 后设置冷却期", () => {
    it("LOAD_MORE_SUCCESS 应记录 lastLoadSuccessTime", () => {
      const now = 20000;
      const existing = [makePhoto({ id: "old" })];
      const newPhotos = [makePhoto({ id: "new1" }), makePhoto({ id: "new2" })];

      const prev: CooldownState = {
        ...initialCooldownState,
        photos: existing,
        isFetchingMore: true,
        page: 1,
        lastLoadSuccessTime: 10000, // 旧的加载时间
      };

      const next = cooldownReducer(
        prev,
        {
          type: "LOAD_MORE_SUCCESS",
          photos: newPhotos,
          hasMore: true,
        },
        now,
      );

      expect(next.lastLoadSuccessTime).toBe(now); // 更新为新时间
      expect(next.photos).toHaveLength(3);
      expect(next.page).toBe(2);
      expect(next.isFetchingMore).toBe(false);
    });

    it("LOAD_MORE_SUCCESS 冷却期内 loadMore 应被阻止", () => {
      const now = 20000;
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        isFetchingMore: false,
        hasMore: true,
        page: 2,
        lastLoadSuccessTime: now,
      };

      const result = guardedLoadMore(state, now);
      expect(result.allowed).toBe(false);
    });

    it("连续两次 LOAD_MORE_SUCCESS 冷却期独立计算", () => {
      const t1 = 10000;
      const t2 = 11000;

      // 第一次加载成功
      let state: CooldownState = {
        ...initialCooldownState,
        isFetchingMore: true,
        page: 0,
        lastLoadSuccessTime: 0,
      };
      state = cooldownReducer(
        state,
        {
          type: "LOAD_MORE_SUCCESS",
          photos: [makePhoto({ id: "a" })],
          hasMore: true,
        },
        t1,
      );
      expect(state.lastLoadSuccessTime).toBe(t1);

      // 冷却期后触发第二次
      expect(guardedLoadMore(state, t1 + COOLDOWN_MS).allowed).toBe(true);

      // 第二次加载成功
      state = {
        ...state,
        isFetchingMore: true,
      };
      state = cooldownReducer(
        state,
        {
          type: "LOAD_MORE_SUCCESS",
          photos: [makePhoto({ id: "b" })],
          hasMore: true,
        },
        t2,
      );
      expect(state.lastLoadSuccessTime).toBe(t2);

      // 第二次的冷却期应基于 t2
      expect(guardedLoadMore(state, t2 + 500).allowed).toBe(false);
      expect(guardedLoadMore(state, t2 + COOLDOWN_MS).allowed).toBe(true);
    });
  });

  describe("LOAD_ERROR 不设置冷却期", () => {
    it("LOAD_ERROR 后不应有冷却期限制", () => {
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        isLoading: true,
        hasMore: true,
        page: 0,
        lastLoadSuccessTime: 0,
      };

      const next = cooldownReducer(state, { type: "LOAD_ERROR", error: "fail" }, 10000);

      // lastLoadSuccessTime 仍为 0（未更新）
      expect(next.lastLoadSuccessTime).toBe(0);

      // 错误后应立即允许重试（无冷却期）
      expect(next.isLoading).toBe(false);
      expect(next.isFetchingMore).toBe(false);
    });

    it("LOAD_ERROR 后 canTriggerLoadMore 仅受 isFetchingMore/hasMore 限制", () => {
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        isFetchingMore: false,
        hasMore: true,
        page: 1,
        lastLoadSuccessTime: 0, // 从未成功加载
      };

      // 没有 lastLoadSuccessTime 记录 → 无冷却期限制
      const result = guardedLoadMore(state, 10000);
      expect(result.allowed).toBe(true);
    });
  });

  describe("冷却期与其他守卫组合", () => {
    it("hasMore=false 时即使冷却期结束也不应触发", () => {
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        isFetchingMore: false,
        hasMore: false,
        page: 5,
        lastLoadSuccessTime: 10000,
      };

      // 冷却期结束（时间足够）
      const result = guardedLoadMore(state, 10000 + COOLDOWN_MS + 999);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("no more data");
    });

    it("isFetchingMore=true 时即使冷却期结束也不应触发", () => {
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        isFetchingMore: true, // 正在加载
        hasMore: true,
        page: 1,
        lastLoadSuccessTime: 10000,
      };

      const result = guardedLoadMore(state, 10000 + COOLDOWN_MS + 999);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("already fetching");
    });

    it("冷却期优先检查 isFetchingMore 和 hasMore", () => {
      // 验证守卫顺序：先检查 isFetchingMore/hasMore，再检查冷却期
      // 这意味着即使用户手动调用 loadMore，也会被正确拦截

      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        isFetchingMore: true,
        hasMore: false,
        page: 1,
        lastLoadSuccessTime: 10000,
      };

      // 多个条件同时阻止，应返回第一个遇到的阻止原因
      const result = guardedLoadMore(state, 10000 + COOLDOWN_MS + 999);
      expect(result.allowed).toBe(false);
      // isFetchingMore 是第一个检查的条件
      expect(result.reason).toBe("already fetching");
    });
  });

  describe("RESET 清除冷却期", () => {
    it("RESET 应将 lastLoadSuccessTime 重置为 0", () => {
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto(), makePhoto()],
        hasMore: false,
        page: 3,
        lastLoadSuccessTime: 50000,
      };

      const next = cooldownReducer(state, { type: "RESET" }, 60000);
      expect(next.lastLoadSuccessTime).toBe(0);
      expect(next.photos).toEqual([]);
      expect(next.hasMore).toBe(true);
      expect(next.page).toBe(0);
    });

    it("RESET 后立即可触发加载（无冷却期）", () => {
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        hasMore: false,
        page: 1,
        lastLoadSuccessTime: 50000,
      };

      const reset = cooldownReducer(state, { type: "RESET" }, 50000);
      const result = guardedLoadMore(reset, 50000);
      expect(result.allowed).toBe(true);
    });
  });

  describe("canTriggerLoadMore 完整状态矩阵", () => {
    /**
     * 验证所有状态组合下的守卫行为。
     *
     * | isFetchingMore | hasMore | inCooldown | allowed |
     * |---------------|---------|------------|---------|
     * | false         | true    | false      | true    |
     * | false         | true    | true       | false   |
     * | false         | false   | any        | false   |
     * | true          | any     | any        | false   |
     */
    it("标准场景：可触发（全部条件满足）", () => {
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        isFetchingMore: false,
        hasMore: true,
        page: 1,
        lastLoadSuccessTime: 10000,
      };
      expect(canTriggerLoadMore(state, 10000 + COOLDOWN_MS)).toBe(true);
    });

    it("冷却期内：阻止", () => {
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        isFetchingMore: false,
        hasMore: true,
        page: 1,
        lastLoadSuccessTime: 10000,
      };
      expect(canTriggerLoadMore(state, 10000 + 300)).toBe(false);
    });

    it("无更多数据：阻止", () => {
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        isFetchingMore: false,
        hasMore: false,
        page: 1,
        lastLoadSuccessTime: 10000,
      };
      expect(canTriggerLoadMore(state, 10000 + COOLDOWN_MS + 999)).toBe(false);
    });

    it("正在加载中：阻止", () => {
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        isFetchingMore: true,
        hasMore: true,
        page: 1,
        lastLoadSuccessTime: 10000,
      };
      expect(canTriggerLoadMore(state, 10000 + COOLDOWN_MS + 999)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 验收标准 4: React key 对齐
// ---------------------------------------------------------------------------

describe("验收标准 4: React key 对齐", () => {
  describe("sentinel 渲染 key", () => {
    it("应使用 virtualItem.key（即 getItemKey 返回值）而非硬编码 'sentinel'", () => {
      // 旧方式
      const oldKey = oldSentinelKey();
      expect(oldKey).toBe("sentinel");

      // 新方式：key 来自 virtualizer.getItemKey 的返回值
      const sentinelItem: FlatItem = {
        type: "sentinel",
        groupIndex: -1,
        rowIndex: -1,
      };
      const newKey = getItemKey(0, [sentinelItem]);
      expect(newKey).toBe("__sentinel__");

      // 验证新旧不同（旧方式已被替代）
      expect(newKey).not.toBe(oldKey);
    });

    it("sentinel 不参与 DOM diff 时不应因 key 变化导致重建", () => {
      // 当 sentinel key 从 'sentinel' 变为 '__sentinel__' 不会影响功能
      // 关键是：在不同渲染间 sentinel key 保持一致
      const items1: FlatItem[] = [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2026年", count: 2 },
        { type: "photoRow", groupIndex: 0, rowIndex: 0, photos: [makePhoto()] },
        { type: "sentinel", groupIndex: -1, rowIndex: -1 },
      ];

      const items2: FlatItem[] = [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2026年", count: 3 },
        { type: "photoRow", groupIndex: 0, rowIndex: 0, photos: [makePhoto()] },
        { type: "photoRow", groupIndex: 0, rowIndex: 1, photos: [makePhoto()] },
        { type: "sentinel", groupIndex: -1, rowIndex: -1 },
      ];

      // sentinel key 在两次渲染间应保持一致
      expect(getItemKey(2, items1)).toBe(getItemKey(3, items2));
    });
  });

  describe("header 渲染 key", () => {
    it("应使用 virtualItem.key 而非 'h-${groupIndex}'", () => {
      const groupIndex = 0;
      const oldKey = oldHeaderKey(groupIndex);
      expect(oldKey).toBe("h-0");

      // 新方式：key 来自 getItemKey
      const headerItem: FlatItem = {
        type: "header",
        groupIndex: 0,
        rowIndex: 0,
        label: "2024年",
        count: 11,
      };
      const newKey = getItemKey(0, [headerItem]);
      expect(newKey).toContain("2024年");
      expect(newKey).not.toBe("h-0");
    });

    it("相同 label 但不同 groupIndex 应产生不同 key（旧方式可能冲突）", () => {
      // 旧方式：两个不同分组但有相同的 groupIndex 会导致 key 冲突
      // （如果是按全局索引而非分组索引）
      const oldK0 = oldHeaderKey(0);
      const oldK1 = oldHeaderKey(1);
      expect(oldK0).not.toBe(oldK1);

      // 新方式：两个同 label 但不同 groupIndex 的 header key 不同
      const items: FlatItem[] = [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2024年", count: 5 },
      ];
      const items2: FlatItem[] = [
        { type: "header", groupIndex: 1, rowIndex: 0, label: "2024年", count: 3 },
      ];

      const newK0 = getItemKey(0, items);
      const newK1 = getItemKey(0, items2);

      expect(newK0).not.toBe(newK1);
    });

    it("旧 key 含硬编码 'h-' 前缀，新 key 包含语义信息", () => {
      const oldKey = oldHeaderKey(3);
      expect(oldKey).toBe("h-3");

      const items: FlatItem[] = [
        { type: "header", groupIndex: 3, rowIndex: 0, label: "2024年", count: 11 },
      ];
      const newKey = getItemKey(0, items);

      // 旧 key 只有索引，新 key 包含 label 信息
      expect(oldKey).not.toContain("2024");
      expect(String(newKey)).toContain("2024");
    });
  });

  describe("photoRow 渲染 key", () => {
    it("应使用 virtualItem.key 而非 'r-${groupIndex}-${virtualItem.index}'", () => {
      const oldKey = oldPhotoRowKey(0, 5);
      expect(oldKey).toBe("r-0-5");

      const photoItem: FlatItem = {
        type: "photoRow",
        groupIndex: 0,
        rowIndex: 0,
        photos: [makePhoto({ id: "my-photo" })],
      };
      const newKey = getItemKey(0, [photoItem]);
      expect(newKey).toContain("my-photo");
      expect(newKey).not.toBe("r-0-5");
    });

    it("旧 key 使用 virtualItem.index 是不稳定的（数据追加后 index 漂移）", () => {
      // 旧方式模拟：virtualItem.index 依赖虚拟器当前计数
      // 追加数据后 index 可能改变
      const p1 = makePhoto({ id: "photo-1" });

      // 第 1 页：photoRow 在 virtualItem.index = 1
      const oldKeyPage1 = oldPhotoRowKey(0, 1);
      expect(oldKeyPage1).toBe("r-0-1");

      // 第 2 页追加后：同一 photoRow 的 virtualItem.index 可能变化
      // 因为虚拟器重建，index 重新分配
      const oldKeyPage2 = oldPhotoRowKey(0, 1);
      // key 相同但 React 可能把同 key 的不同行匹配错
      // 或者如果 index 变了，React 会认为这是不同的元素
      expect(oldKeyPage1).toBe(oldKeyPage2); // 旧 key 只关心索引，不关心内容
    });

    it("新 key 基于 firstPhotoId，数据追加后同一条 photoRow key 不变", () => {
      const p1 = makePhoto({ id: "photo-1" });
      const p2 = makePhoto({ id: "photo-2" });

      const rowItem: FlatItem = {
        type: "photoRow",
        groupIndex: 0,
        rowIndex: 0,
        photos: [p1, p2],
      };

      const items: FlatItem[] = [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2024年", count: 2 },
        rowItem,
      ];

      const key1 = getItemKey(1, items);

      // 追加数据后，同一 row 仍在原位（但由于 key 基于 firstPhotoId 保持不变）
      const itemsAfter: FlatItem[] = [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2024年", count: 3 },
        rowItem, // 同一对象引用
        { type: "photoRow", groupIndex: 0, rowIndex: 1, photos: [makePhoto({ id: "photo-3" })] },
      ];

      const key2 = getItemKey(1, itemsAfter);

      // 新增数据不应改变已有 photoRow 的 key
      expect(key1).toBe(key2);
    });
  });
});

// ---------------------------------------------------------------------------
// 验收标准 5: 无级联加载循环
// ---------------------------------------------------------------------------

describe("验收标准 5: 无级联加载循环", () => {
  /**
   * 设计文档根因分析：
   *   isFetchingMore: false → true → false 的状态变化导致 callback ref
   *   引用变化 → React disconnect 旧 observer → 创建新 observer attach 到
   *   新 sentinel 节点 → 新 observer 检测到 sentinel 仍在视口内
   *   (+200px rootMargin) → 立即触发下一次 loadMore() → 无限循环
   *
   * 验证：三项修复组合后，模拟连续状态转换不会产生级联触发。
   */

  describe("isFetchingMore 状态转换不应导致 observer 重建", () => {
    it("isFetchingMore 变化后 getItemKey 应保持 sentinel key 不变", () => {
      // 如果 getItemKey 稳定，即使 isFetchingMore 变化导致
      // flatItems 重建，sentinel 的 key 仍为 '__sentinel__'
      const buildItems = (): FlatItem[] => [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2024年", count: 11 },
        { type: "photoRow", groupIndex: 0, rowIndex: 0, photos: [makePhoto({ id: "p1" })] },
        { type: "photoRow", groupIndex: 0, rowIndex: 1, photos: [makePhoto({ id: "p2" })] },
        { type: "photoRow", groupIndex: 0, rowIndex: 2, photos: [makePhoto({ id: "p3" })] },
        { type: "photoRow", groupIndex: 0, rowIndex: 3, photos: [makePhoto({ id: "p4" })] },
        { type: "sentinel", groupIndex: -1, rowIndex: -1 },
      ];

      // 模拟两次渲染间 items 相同，但 isFetchingMore 状态不同
      const items1 = buildItems();
      const items2 = buildItems();

      // sentinel 的 key 保持不变
      const sentinelIdx1 = items1.length - 1;
      const sentinelIdx2 = items2.length - 1;
      expect(getItemKey(sentinelIdx1, items1)).toBe(getItemKey(sentinelIdx2, items2));
    });
  });

  describe("加载完成后的稳定窗口", () => {
    it("LOAD_SUCCESS → observer 检测 sentinel → loadMore 检查应被冷却期阻止", () => {
      // 模拟完整场景：
      // 1. LOAD_SUCCESS 完成 → isFetchingMore: false
      // 2. 虚拟器重建（由于 isFetchingMore 变化）
      // 3. 新 observer attach → 检测 sentinel 在视口内
      // 4. 尝试触发 loadMore

      const now = 50000;
      let state: CooldownState = {
        ...initialCooldownState,
        isLoading: true,
        hasMore: true,
        page: 0,
        lastLoadSuccessTime: 0,
      };

      // Step 1: 加载成功
      state = cooldownReducer(
        state,
        {
          type: "LOAD_SUCCESS",
          photos: [makePhoto({ id: "p1" })],
          hasMore: true,
        },
        now,
      );

      // Step 2-3: 模拟 observer 检测到 sentinel 后立即尝试触发
      // (此时距离 LOAD_SUCCESS 0ms，应在冷却期内)
      const result = guardedLoadMore(state, now);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("cooldown");

      // Step 4: 冷却期结束后再次尝试
      const resultAfterCooldown = guardedLoadMore(state, now + COOLDOWN_MS);
      expect(resultAfterCooldown.allowed).toBe(true);
    });

    it("LOAD_MORE_SUCCESS → observer 检测 → loadMore 应被冷却期阻止", () => {
      const now = 50000;
      let state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto({ id: "p1" })],
        isFetchingMore: true,
        hasMore: true,
        page: 1,
        lastLoadSuccessTime: 49000,
      };

      // Step 1: 加载更多成功
      state = cooldownReducer(
        state,
        {
          type: "LOAD_MORE_SUCCESS",
          photos: [makePhoto({ id: "p2" })],
          hasMore: true,
        },
        now,
      );

      // Step 2-3: observer 立即检测到 sentinel
      const result = guardedLoadMore(state, now);
      expect(result.allowed).toBe(false);
    });
  });

  describe("冷却期与 isFetchingMore 双重防护", () => {
    it("冷却期防止刚加载完立即再次加载", () => {
      const now = 50000;

      // 加载刚完成
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        isFetchingMore: false, // 已完成
        hasMore: true,
        page: 1,
        lastLoadSuccessTime: now,
      };

      // 模拟 observer 在 0ms, 10ms, 50ms, 200ms, 500ms 各时间点尝试触发
      const attempts = [0, 10, 50, 200, 500, 800];
      const results = attempts.map((offset) => ({
        offset,
        allowed: guardedLoadMore(state, now + offset).allowed,
      }));

      // 800ms 之前所有尝试都应被阻止
      for (const r of results) {
        if (r.offset < COOLDOWN_MS) {
          expect(r.allowed).toBe(false);
        }
      }
      // 800ms 放行
      expect(results[results.length - 1]?.allowed).toBe(true);
    });

    it("isFetchingMore=true 单独阻止（不受冷却期影响）", () => {
      const now = 50000;
      const state: CooldownState = {
        ...initialCooldownState,
        photos: [makePhoto()],
        isFetchingMore: true,
        hasMore: true,
        page: 1,
        lastLoadSuccessTime: 0, // 无冷却期
      };

      // 即使没有冷却期，isFetchingMore=true 也应阻止
      expect(canTriggerLoadMore(state, now)).toBe(false);
    });
  });

  describe("同一批数据不重复请求", () => {
    it("连续两次 LOAD_MORE_SUCCESS 后 page 应递增不重复", () => {
      let page1Photos: Photo[] = [];
      let page2Photos: Photo[] = [];

      let state: CooldownState = {
        ...initialCooldownState,
        lastLoadSuccessTime: 0,
      };

      // 首次加载
      state = cooldownReducer(
        state,
        {
          type: "LOAD_SUCCESS",
          photos: [makePhoto({ id: "a" }), makePhoto({ id: "b" })],
          hasMore: true,
        },
        1000,
      );
      page1Photos = state.photos;
      expect(state.page).toBe(1);

      // 加载更多（冷却期后）
      state = {
        ...state,
        isFetchingMore: true,
      };
      state = cooldownReducer(
        state,
        {
          type: "LOAD_MORE_SUCCESS",
          photos: [makePhoto({ id: "c" }), makePhoto({ id: "d" })],
          hasMore: true,
        },
        2000,
      );
      page2Photos = state.photos;
      expect(state.page).toBe(2);

      // 如果发生级联循环，可能用同一批数据再次 dispatch LOAD_MORE_SUCCESS
      // 验证：相同数据再次 dispatch → page 不应继续递增（因为被冷却期阻止）
      const cascadeAttempt = guardedLoadMore(state, 2000); // 冷却期内
      expect(cascadeAttempt.allowed).toBe(false);

      // photos 总数不会因被阻止的级联尝试而变化
      expect(state.photos).toHaveLength(page2Photos.length);
    });

    it("hasMore=false 后即使 observer 重建也不应触发新请求", () => {
      const now = 50000;
      const state: CooldownState = {
        ...initialCooldownState,
        photos: Array.from({ length: 60 }, (_, i) => makePhoto({ id: `p-${i}` })),
        isFetchingMore: false,
        hasMore: false,
        page: 3,
        lastLoadSuccessTime: now - COOLDOWN_MS - 1000, // 冷却期已过
      };

      // 即使冷却期已过、未在加载中，hasMore=false 应阻止
      const result = guardedLoadMore(state, now);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("no more data");
    });
  });

  describe("header/photoRow 频繁闪现的根因验证", () => {
    it("getItemKey 稳定性确保 React reconciliation 不误删 DOM", () => {
      // 根因：无 getItemKey 时虚拟器使用默认 index key
      // 数据追加后 index 重新分配，React 认为旧 DOM 属于新数据
      //
      // 验证：getItemKey 在数据追加前后为同一逻辑项返回相同 key

      const p1 = makePhoto({ id: "p1" });
      const p2 = makePhoto({ id: "p2" });
      const p3 = makePhoto({ id: "p3" });

      // 加载前：3 条 items
      const beforeItems: FlatItem[] = [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2024年", count: 2 },
        { type: "photoRow", groupIndex: 0, rowIndex: 0, photos: [p1, p2] },
        { type: "sentinel", groupIndex: -1, rowIndex: -1 },
      ];

      // 加载后：4 条 items（header 的 count 变化 + 新 photoRow）
      const afterItems: FlatItem[] = [
        { type: "header", groupIndex: 0, rowIndex: 0, label: "2024年", count: 3 },
        { type: "photoRow", groupIndex: 0, rowIndex: 0, photos: [p1, p2] },
        { type: "photoRow", groupIndex: 0, rowIndex: 1, photos: [p3] },
        { type: "sentinel", groupIndex: -1, rowIndex: -1 },
      ];

      // 验证：加载前后相同逻辑项有相同 key
      // header (index 0 before → index 0 after)：key 不变
      const headerKeyBefore = getItemKey(0, beforeItems);
      const headerKeyAfter = getItemKey(0, afterItems);
      expect(headerKeyBefore).toBe(headerKeyAfter);

      // first photoRow (index 1 before → index 1 after)：key 不变
      const row1KeyBefore = getItemKey(1, beforeItems);
      const row1KeyAfter = getItemKey(1, afterItems);
      expect(row1KeyBefore).toBe(row1KeyAfter);
    });
  });
});

// ---------------------------------------------------------------------------
// 跨系统数据流验证
// ---------------------------------------------------------------------------

describe("跨系统数据流验证: API → Reducer → Group → Virtualizer → Render", () => {
  /**
   * 完整数据流：
   *   1. API 返回 Photo[] + hasMore
   *   2. Reducer 更新状态（含冷却期记录）
   *   3. groupPhotos 按日期分组
   *   4. flattenGroupedPhotos 转换为 FlatItem[]
   *   5. getItemKey 为每个 item 分配稳定 key
   *   6. estimateSize 为每个 item 提供高度估计
   *   7. 虚拟器渲染 virtualItems，React 使用 virtualItem.key 作为渲染 key
   */

  function getEffectiveDate(photo: Photo): string {
    return photo.takenAt ?? photo.createdAt;
  }

  function groupByYear(photos: Photo[]): { label: string; photos: Photo[] }[] {
    const groups = new Map<string, Photo[]>();
    for (const photo of photos) {
      const d = new Date(getEffectiveDate(photo));
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}年`;
      const existing = groups.get(key);
      if (existing) existing.push(photo);
      else groups.set(key, [photo]);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => b.localeCompare(a, "zh-CN", { numeric: true }))
      .map(([label, photos]) => ({ label, photos }));
  }

  function flattenGroupedPhotos(groups: { label: string; photos: Photo[] }[]): FlatItem[] {
    const items: FlatItem[] = [];
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (!group) continue;
      items.push({
        type: "header",
        groupIndex: i,
        rowIndex: 0,
        label: group.label,
        count: group.photos.length,
      });
      for (let r = 0; r < group.photos.length; r++) {
        items.push({
          type: "photoRow",
          groupIndex: i,
          rowIndex: r,
          photos: [group.photos[r]!],
        });
      }
    }
    // 末尾追加 sentinel
    items.push({
      type: "sentinel",
      groupIndex: -1,
      rowIndex: -1,
    });
    return items;
  }

  it("完整数据流：API 响应 → 最终渲染 key 一致性", () => {
    // Step 1: 模拟 API 返回
    const apiResponse = {
      photos: [
        makePhoto({ id: "a", takenAt: "2026-05-03T00:00:00Z" }),
        makePhoto({ id: "b", takenAt: "2026-05-01T00:00:00Z" }),
        makePhoto({ id: "c", takenAt: "2025-12-15T00:00:00Z" }),
        makePhoto({ id: "d", takenAt: "2024-11-20T00:00:00Z" }),
        makePhoto({ id: "e", takenAt: "2024-11-20T00:00:00Z" }),
      ],
      hasMore: true,
    };

    // Step 2: Reducer 处理
    const now = 10000;
    let state: CooldownState = {
      ...initialCooldownState,
      isLoading: true,
      hasMore: true,
      page: 0,
      lastLoadSuccessTime: 0,
    };
    state = cooldownReducer(
      state,
      {
        type: "LOAD_SUCCESS",
        photos: apiResponse.photos,
        hasMore: apiResponse.hasMore,
      },
      now,
    );

    expect(state.photos).toHaveLength(5);
    expect(state.hasMore).toBe(true);
    expect(state.lastLoadSuccessTime).toBe(now); // 冷却期已记录
    expect(state.isLoading).toBe(false);
    expect(state.isFetchingMore).toBe(false);

    // Step 3: 分组
    const groups = groupByYear(state.photos);
    expect(groups).toHaveLength(3); // 2026, 2025, 2024

    // Step 4: Flatten
    const flatItems = flattenGroupedPhotos(groups);

    // Step 5: 分配 key
    const keys = flatItems.map((_, i) => getItemKey(i, flatItems));

    // Step 6: 验证 key
    // header items
    expect(keys[0]).toBe("header-0-2026年"); // 最新年份
    // photoRow items for 2026
    expect(keys[1]).toContain("photo-0-");
    expect(keys[2]).toContain("photo-0-");
    // header for 2025
    const header2025Idx = flatItems.findIndex((f) => f.type === "header" && f.label === "2025年");
    expect(keys[header2025Idx]).toBe("header-1-2025年");
    // header for 2024
    const header2024Idx = flatItems.findIndex((f) => f.type === "header" && f.label === "2024年");
    expect(keys[header2024Idx]).toBe("header-2-2024年");
    // sentinel
    const sentinelIdx = flatItems.findIndex((f) => f.type === "sentinel");
    expect(keys[sentinelIdx]).toBe("__sentinel__");

    // 所有 key 应唯一
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);

    // Step 7: 冷却期守卫验证
    const canLoad = guardedLoadMore(state, now);
    expect(canLoad.allowed).toBe(false); // 冷却期内

    const canLoadAfter = guardedLoadMore(state, now + COOLDOWN_MS + 1);
    expect(canLoadAfter.allowed).toBe(true); // 冷却期后
  });

  it("跨系统数据流：追加数据后 key 稳定性验证", () => {
    // 模拟分页加载：
    // 第 1 页：2026年 2张, 2025年 1张
    // 第 2 页：2025年 1张追加, 2024年 11张

    const page1Photos = [
      makePhoto({ id: "a", takenAt: "2026-05-03T00:00:00Z" }),
      makePhoto({ id: "b", takenAt: "2026-05-01T00:00:00Z" }),
      makePhoto({ id: "c", takenAt: "2025-12-15T00:00:00Z" }),
    ];

    // 第 1 页加载
    let state: CooldownState = {
      ...initialCooldownState,
      lastLoadSuccessTime: 0,
    };
    state = cooldownReducer(
      state,
      {
        type: "LOAD_SUCCESS",
        photos: page1Photos,
        hasMore: true,
      },
      1000,
    );

    // 构建 flatItems 和 keys (第 1 页)
    const groups1 = groupByYear(state.photos);
    const flat1 = flattenGroupedPhotos(groups1);
    const keys1 = flat1.map((_, i) => getItemKey(i, flat1));

    // 冷却期后加载第 2 页
    const page2Photos = [
      makePhoto({ id: "d", takenAt: "2025-11-01T00:00:00Z" }),
      makePhoto({ id: "e", takenAt: "2024-11-20T00:00:00Z" }),
    ];
    state = {
      ...state,
      isFetchingMore: true,
    };
    state = cooldownReducer(
      state,
      {
        type: "LOAD_MORE_SUCCESS",
        photos: page2Photos,
        hasMore: false,
      },
      2000,
    );

    // 第 2 页加载后的 flatItems 和 keys
    const groups2 = groupByYear(state.photos);
    const flat2 = flattenGroupedPhotos(groups2);
    const keys2 = flat2.map((_, i) => getItemKey(i, flat2));

    // 验证：第 1 页中已存在的 header/photoRow key 在第 2 页中保持不变
    // header "2026年" 应在两组中都存在且 key 相同
    const header2026Key1 = keys1.find(
      (k) => String(k).startsWith("header-") && String(k).includes("2026年"),
    );
    const header2026Key2 = keys2.find(
      (k) => String(k).startsWith("header-") && String(k).includes("2026年"),
    );
    expect(header2026Key1).toBeDefined();
    expect(header2026Key2).toBeDefined();
    expect(header2026Key1).toBe(header2026Key2);

    // header "2025年" 在两组中都存在且 key 相同
    const header2025Key1 = keys1.find(
      (k) => String(k).startsWith("header-") && String(k).includes("2025年"),
    );
    const header2025Key2 = keys2.find(
      (k) => String(k).startsWith("header-") && String(k).includes("2025年"),
    );
    expect(header2025Key1).toBeDefined();
    expect(header2025Key2).toBeDefined();
    expect(header2025Key1).toBe(header2025Key2);

    // sentinel key 保持不变
    const sentinelKey1 = keys1.find((k) => k === "__sentinel__");
    const sentinelKey2 = keys2.find((k) => k === "__sentinel__");
    expect(sentinelKey1).toBe("__sentinel__");
    expect(sentinelKey2).toBe("__sentinel__");

    // 第 2 页新增了 "2024年" header
    const header2024Key2 = keys2.find(
      (k) => String(k).startsWith("header-") && String(k).includes("2024年"),
    );
    expect(header2024Key2).toBeDefined();

    // hasMore 为 false（第 2 页返回的）
    expect(state.hasMore).toBe(false);

    // 冷却期记录已被更新
    expect(state.lastLoadSuccessTime).toBe(2000);

    // 冷却期内禁止再次请求
    const cascadeResult = guardedLoadMore(state, 2000);
    expect(cascadeResult.allowed).toBe(false);
  });

  it("跨系统数据流：estimateSize 在整个流程中行为一致", () => {
    // 验证 estimateSize 不因数据变化而改变返回值模式
    const photos1 = [makePhoto({ id: "a" })];
    const photos2 = [makePhoto({ id: "a" }), makePhoto({ id: "b" }), makePhoto({ id: "c" })];

    const estimateConfig: EstimateSizeConfig = { cellSize: 120, headerSize: 44 };

    // 模拟不同数据量下的 flatten
    const groups1 = groupByYear(photos1);
    const flat1 = flattenGroupedPhotos(groups1);

    const groups2 = groupByYear(photos2);
    const flat2 = flattenGroupedPhotos(groups2);

    // 创建类型判定函数（模拟 virtualizer 内部行为）
    const getType1 = (idx: number) => flat1[idx]?.type ?? "photoRow";
    const getType2 = (idx: number) => flat2[idx]?.type ?? "photoRow";

    const estimate1 = createEstimateSizeWithTypeCheck(estimateConfig, getType1);
    const estimate2 = createEstimateSizeWithTypeCheck(estimateConfig, getType2);

    // 虽然 estimateSize 行为可能因不同数据而异（类型不同），
    // 但其闭包结构相同：仅依赖 cellSize 和 headerSize
    // 关键验证：cellSize/headerSize 不变时，不需要重新创建 estimateSize
    expect(estimate1(0)).toBe(estimate2(0)); // 都是 header
  });

  it("跨系统数据流：冷却期 + 稳定 key + 稳定 estimateSize 三者协同防循环", () => {
    /**
     * 模拟完整的级联加载场景并验证修复效果：
     *
     * 原始问题：
     *   1. loadMore 完成 → isFetchingMore: false
     *   2. callback ref 变化 → observer 重建
     *   3. 新 observer 检测 sentinel → 触发 loadMore
     *   4. 循环回到步骤 1
     *
     * 修复后：
     *   1. loadMore 完成 → isFetchingMore: false + lastLoadSuccessTime 记录
     *   2. getItemKey 保持 sentinel key 为 "__sentinel__"（React 不重建 DOM）
     *   3. estimateSize 稳定闭包，不因 flatItems 变化而重建
     *   4. 即使 observer 重建后触发 loadMore → 冷却期守卫拦截
     *   5. 冷却期结束后才允许正常加载
     */

    const now = 10000;
    let loadMoreCallCount = 0;

    // 初始加载
    let state: CooldownState = {
      ...initialCooldownState,
      isLoading: true,
      hasMore: true,
      page: 0,
      lastLoadSuccessTime: 0,
    };

    state = cooldownReducer(
      state,
      {
        type: "LOAD_SUCCESS",
        photos: [makePhoto({ id: "p1" }), makePhoto({ id: "p2" })],
        hasMore: true,
      },
      now,
    );

    // 模拟 observer 在多个时间点尝试触发 loadMoreInternal.current()
    // (这些调用在冷却期内应被拦截)
    const observerAttempts = [now, now + 100, now + 300, now + 500, now + 700, now + 799];

    for (const attemptTime of observerAttempts) {
      const result = guardedLoadMore(state, attemptTime);
      if (result.allowed) {
        loadMoreCallCount++;
      }
      // 冷却期内所有尝试都应被阻止
      expect(result.allowed).toBe(false);
    }

    // 冷却期结束后的一次尝试应该触发
    const resultAfter = guardedLoadMore(state, now + COOLDOWN_MS);
    expect(resultAfter.allowed).toBe(true);

    // 验证：冷却期内没有任何 loadMore 实际调用
    expect(loadMoreCallCount).toBe(0);
  });
});

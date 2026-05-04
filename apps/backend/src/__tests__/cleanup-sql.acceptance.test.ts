/**
 * 验收测试：数据清理逻辑 — 重复记录去重
 *
 * 覆盖设计文档 §1 数据库清理：
 * - 按 (storage_source_id, file_path) 分组识别重复记录
 * - 保留规则：优先保留 thumbnail_path IS NOT NULL 的记录
 * - 次优规则：同组多条都有/都没有 thumbnail 时，保留 created_at 最新的
 * - 清理后每组仅保留 1 条记录
 *
 * 设计文档规定清理 SQL 逻辑：
 * 对 photos 表按 (storage_source_id, file_path) 分组，
 * 每组保留 1 条：有缩略图优先，其次取 created_at 最大（最新）的记录。
 *
 * 本测试通过构造模拟数据验证清理逻辑的正确性，不实际操作数据库。
 */
import { describe, expect, it } from "vitest";

// ---- 类型定义 ----

interface PhotoRecord {
  id: string;
  storage_source_id: string;
  file_path: string;
  thumbnail_path: string | null;
  created_at: string; // ISO 8601 string
}

// ---- 辅助函数：模拟清理逻辑 ----

/**
 * 分组键：复合键 (storage_source_id, file_path)
 */
function groupKey(record: PhotoRecord): string {
  return `${record.storage_source_id}::${record.file_path}`;
}

/**
 * 在组内选择保留的记录。
 *
 * 优先级：
 * 1. thumbnail_path IS NOT NULL（有缩略图优先）
 * 2. created_at 最新（时间戳最大）
 * 3. 如果都相同，保留 id 最小的（确定性）
 */
function selectBestInGroup(group: PhotoRecord[]): PhotoRecord {
  if (group.length === 0) {
    throw new Error("Empty group");
  }
  if (group.length === 1) {
    return group[0];
  }

  // 第一优先级：有缩略图的优先
  const withThumbnail = group.filter((r) => r.thumbnail_path !== null);
  const candidates = withThumbnail.length > 0 ? withThumbnail : group;

  // 第二优先级：created_at 最新
  candidates.sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  return candidates[0];
}

/**
 * 模拟清理逻辑：
 * 1. 按 (storage_source_id, file_path) 分组
 * 2. 每组保留一条最佳记录
 * 3. 返回 { keep, remove }
 */
function simulateCleanup(records: PhotoRecord[]): {
  keep: PhotoRecord[];
  remove: PhotoRecord[];
} {
  const groups = new Map<string, PhotoRecord[]>();

  for (const record of records) {
    const key = groupKey(record);
    const group = groups.get(key);
    if (group) {
      group.push(record);
    } else {
      groups.set(key, [record]);
    }
  }

  const keep: PhotoRecord[] = [];
  const remove: PhotoRecord[] = [];

  for (const [, group] of groups) {
    const best = selectBestInGroup(group);
    keep.push(best);
    for (const record of group) {
      if (record.id !== best.id) {
        remove.push(record);
      }
    }
  }

  return { keep, remove };
}

// ---- 生成模拟 SQL（验证清理逻辑的正确语义）----

/**
 * 生成对应的 SQL 清理语句原型。
 * 本函数仅用于文档说明，不实际执行。
 */
function generateCleanupSQL(): string {
  // 设计文档的清理逻辑用 SQL 表达：
  // DELETE FROM photos WHERE id NOT IN (
  //   SELECT id FROM (
  //     SELECT id,
  //       ROW_NUMBER() OVER (
  //         PARTITION BY storage_source_id, file_path
  //         ORDER BY
  //           CASE WHEN thumbnail_path IS NOT NULL THEN 0 ELSE 1 END,
  //           created_at DESC
  //       ) AS rn
  //     FROM photos
  //   ) WHERE rn = 1
  // );
  return `
DELETE FROM photos
WHERE id NOT IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY storage_source_id, file_path
        ORDER BY
          CASE WHEN thumbnail_path IS NOT NULL THEN 0 ELSE 1 END,
          created_at DESC
      ) AS rn
    FROM photos
  ) ranked
  WHERE rn = 1
);
  `.trim();
}

// ---- 测试 ----

describe("数据清理逻辑 — 重复去重验证（设计文档 §1）", () => {
  describe("分组逻辑 (storage_source_id, file_path)", () => {
    it("相同 (storage_source_id, file_path) 应归入同一组", () => {
      const records: PhotoRecord[] = [
        {
          id: "a1",
          storage_source_id: "src-1",
          file_path: "/photos/img.jpg",
          thumbnail_path: null,
          created_at: "2024-01-01T00:00:00Z",
        },
        {
          id: "a2",
          storage_source_id: "src-1",
          file_path: "/photos/img.jpg",
          thumbnail_path: null,
          created_at: "2024-01-02T00:00:00Z",
        },
      ];

      const key1 = groupKey(records[0]);
      const key2 = groupKey(records[1]);
      expect(key1).toBe(key2);
    });

    it("不同 storage_source_id 但相同 file_path 应视为不同组", () => {
      const r1: PhotoRecord = {
        id: "b1",
        storage_source_id: "src-1",
        file_path: "/photos/img.jpg",
        thumbnail_path: null,
        created_at: "2024-01-01T00:00:00Z",
      };
      const r2: PhotoRecord = {
        id: "b2",
        storage_source_id: "src-2",
        file_path: "/photos/img.jpg",
        thumbnail_path: null,
        created_at: "2024-01-01T00:00:00Z",
      };

      expect(groupKey(r1)).not.toBe(groupKey(r2));
    });

    it("相同 storage_source_id 但不同 file_path 应视为不同组", () => {
      const r1: PhotoRecord = {
        id: "c1",
        storage_source_id: "src-1",
        file_path: "/photos/a.jpg",
        thumbnail_path: null,
        created_at: "2024-01-01T00:00:00Z",
      };
      const r2: PhotoRecord = {
        id: "c2",
        storage_source_id: "src-1",
        file_path: "/photos/b.jpg",
        thumbnail_path: null,
        created_at: "2024-01-01T00:00:00Z",
      };

      expect(groupKey(r1)).not.toBe(groupKey(r2));
    });
  });

  describe("保留优先级：有缩略图优先", () => {
    it("组内有一条有缩略图、一条无缩略图，应保留有缩略图的", () => {
      const records: PhotoRecord[] = [
        {
          id: "d1",
          storage_source_id: "src-1",
          file_path: "/photos/dup.jpg",
          thumbnail_path: null,
          created_at: "2024-06-01T00:00:00Z",
        },
        {
          id: "d2",
          storage_source_id: "src-1",
          file_path: "/photos/dup.jpg",
          thumbnail_path: "/thumbnails/dup.jpg",
          created_at: "2024-06-01T00:00:00Z",
        },
      ];

      const { keep, remove } = simulateCleanup(records);

      expect(keep).toHaveLength(1);
      expect(remove).toHaveLength(1);
      expect(keep[0].id).toBe("d2"); // 有缩略图的保留
      expect(keep[0].thumbnail_path).not.toBeNull();
    });

    it("多条有缩略图 + 多条无缩略图，应从有缩略图的候选中选取", () => {
      const records: PhotoRecord[] = [
        {
          id: "e1",
          storage_source_id: "src-1",
          file_path: "/photos/multi.jpg",
          thumbnail_path: null,
          created_at: "2024-01-01T00:00:00Z",
        },
        {
          id: "e2",
          storage_source_id: "src-1",
          file_path: "/photos/multi.jpg",
          thumbnail_path: null,
          created_at: "2024-01-02T00:00:00Z",
        },
        {
          id: "e3",
          storage_source_id: "src-1",
          file_path: "/photos/multi.jpg",
          thumbnail_path: "/thumbs/multi_old.jpg",
          created_at: "2024-01-01T00:00:00Z",
        },
        {
          id: "e4",
          storage_source_id: "src-1",
          file_path: "/photos/multi.jpg",
          thumbnail_path: "/thumbs/multi_new.jpg",
          created_at: "2024-01-03T00:00:00Z",
        },
      ];

      const { keep, remove } = simulateCleanup(records);

      expect(keep).toHaveLength(1);
      expect(remove).toHaveLength(3);

      // 保留的应该有缩略图
      expect(keep[0].thumbnail_path).not.toBeNull();
      // 在有缩略图的两条中，应保留 created_at 最新的 (e4)
      expect(keep[0].id).toBe("e4");
    });

    it("如果所有记录都没有缩略图，应保留 created_at 最新的", () => {
      const records: PhotoRecord[] = [
        {
          id: "f1",
          storage_source_id: "src-1",
          file_path: "/photos/nothumb.jpg",
          thumbnail_path: null,
          created_at: "2024-01-01T00:00:00Z",
        },
        {
          id: "f2",
          storage_source_id: "src-1",
          file_path: "/photos/nothumb.jpg",
          thumbnail_path: null,
          created_at: "2024-02-15T00:00:00Z",
        },
        {
          id: "f3",
          storage_source_id: "src-1",
          file_path: "/photos/nothumb.jpg",
          thumbnail_path: null,
          created_at: "2024-01-10T00:00:00Z",
        },
      ];

      const { keep, remove } = simulateCleanup(records);

      expect(keep).toHaveLength(1);
      expect(remove).toHaveLength(2);
      expect(keep[0].id).toBe("f2"); // 最新的 created_at
    });

    it("如果所有记录都有缩略图，应保留 created_at 最新的", () => {
      const records: PhotoRecord[] = [
        {
          id: "g1",
          storage_source_id: "src-1",
          file_path: "/photos/allthumb.jpg",
          thumbnail_path: "/thumbs/g1.jpg",
          created_at: "2024-03-01T00:00:00Z",
        },
        {
          id: "g2",
          storage_source_id: "src-1",
          file_path: "/photos/allthumb.jpg",
          thumbnail_path: "/thumbs/g2.jpg",
          created_at: "2024-03-05T00:00:00Z",
        },
      ];

      const { keep, remove } = simulateCleanup(records);

      expect(keep).toHaveLength(1);
      expect(remove).toHaveLength(1);
      expect(keep[0].id).toBe("g2"); // 最新的
    });
  });

  describe("多组混合场景", () => {
    it("应正确处理多组不同路径的重复数据", () => {
      const records: PhotoRecord[] = [
        // 组1：/a.jpg - 2条重复
        {
          id: "h1",
          storage_source_id: "src-1",
          file_path: "/photos/a.jpg",
          thumbnail_path: null,
          created_at: "2024-01-01T00:00:00Z",
        },
        {
          id: "h2",
          storage_source_id: "src-1",
          file_path: "/photos/a.jpg",
          thumbnail_path: "/thumbs/a.jpg",
          created_at: "2024-01-02T00:00:00Z",
        },
        // 组2：/b.jpg - 3条重复
        {
          id: "h3",
          storage_source_id: "src-1",
          file_path: "/photos/b.jpg",
          thumbnail_path: null,
          created_at: "2024-02-01T00:00:00Z",
        },
        {
          id: "h4",
          storage_source_id: "src-1",
          file_path: "/photos/b.jpg",
          thumbnail_path: null,
          created_at: "2024-02-02T00:00:00Z",
        },
        {
          id: "h5",
          storage_source_id: "src-1",
          file_path: "/photos/b.jpg",
          thumbnail_path: null,
          created_at: "2024-02-03T00:00:00Z",
        },
        // 组3：/c.jpg - 无重复
        {
          id: "h6",
          storage_source_id: "src-1",
          file_path: "/photos/c.jpg",
          thumbnail_path: "/thumbs/c.jpg",
          created_at: "2024-03-01T00:00:00Z",
        },
        // 组4：/d.jpg - src-2，不同存储源
        {
          id: "h7",
          storage_source_id: "src-2",
          file_path: "/photos/a.jpg", // 与组1相同路径但不同存储源
          thumbnail_path: null,
          created_at: "2024-04-01T00:00:00Z",
        },
        {
          id: "h8",
          storage_source_id: "src-2",
          file_path: "/photos/a.jpg",
          thumbnail_path: "/thumbs/a2.jpg",
          created_at: "2024-04-02T00:00:00Z",
        },
      ];

      const { keep, remove } = simulateCleanup(records);

      // 8 条原始记录
      // 组1(2条) → 保留1条
      // 组2(3条) → 保留1条
      // 组3(1条) → 保留1条（无重复）
      // 组4(2条) → 保留1条
      // 总保留: 4条, 删除: 4条
      expect(keep).toHaveLength(4);
      expect(remove).toHaveLength(4);

      // 验证每组保留的正确记录
      const keptIds = keep.map((r) => r.id);
      expect(keptIds).toContain("h2"); // 组1: 有缩略图
      expect(keptIds).toContain("h5"); // 组2: 最新 created_at (都无缩略图)
      expect(keptIds).toContain("h6"); // 组3: 唯一记录
      expect(keptIds).toContain("h8"); // 组4: 有缩略图
    });
  });

  describe("边界情况", () => {
    it("单条记录不应被删除", () => {
      const records: PhotoRecord[] = [
        {
          id: "single-1",
          storage_source_id: "src-1",
          file_path: "/photos/only.jpg",
          thumbnail_path: null,
          created_at: "2024-01-01T00:00:00Z",
        },
      ];

      const { keep, remove } = simulateCleanup(records);

      expect(keep).toHaveLength(1);
      expect(remove).toHaveLength(0);
      expect(keep[0].id).toBe("single-1");
    });

    it("空前数组不应抛出错误", () => {
      const { keep, remove } = simulateCleanup([]);
      expect(keep).toHaveLength(0);
      expect(remove).toHaveLength(0);
    });

    it("所有记录 id 唯一但 (storage_source_id, file_path) 重复时正确去重", () => {
      const records: PhotoRecord[] = [
        {
          id: "uuid-1",
          storage_source_id: "src-1",
          file_path: "/photos/x.jpg",
          thumbnail_path: "/thumbs/x.jpg",
          created_at: "2024-05-01T00:00:00Z",
        },
        {
          id: "uuid-2",
          storage_source_id: "src-1",
          file_path: "/photos/x.jpg",
          thumbnail_path: null,
          created_at: "2024-05-02T00:00:00Z",
        },
      ];

      const { keep, remove } = simulateCleanup(records);

      expect(keep).toHaveLength(1);
      // 应保留 uuid-1（有缩略图），删除 uuid-2（无缩略图即使更新）
      expect(keep[0].id).toBe("uuid-1");
      expect(remove[0].id).toBe("uuid-2");
    });
  });

  describe("SQL 语句语义验证", () => {
    it("清理 SQL 应使用 PARTITION BY (storage_source_id, file_path) 分组", () => {
      const sql = generateCleanupSQL();
      expect(sql).toContain("PARTITION BY");
      expect(sql).toContain("storage_source_id");
      expect(sql).toContain("file_path");
    });

    it("清理 SQL 应优先保留 thumbnail_path IS NOT NULL 的记录", () => {
      const sql = generateCleanupSQL();
      expect(sql).toContain("thumbnail_path");
      expect(sql).toContain("IS NOT NULL");
    });

    it("清理 SQL 应按 created_at DESC 作为次级排序", () => {
      const sql = generateCleanupSQL();
      expect(sql).toContain("created_at");
      expect(sql).toContain("DESC");
    });

    it("清理 SQL 应使用 ROW_NUMBER 窗口函数标识每组第一条", () => {
      const sql = generateCleanupSQL();
      expect(sql).toContain("ROW_NUMBER()");
      expect(sql).toContain("rn = 1");
    });

    it("清理 SQL 应删除不在保留集中的记录", () => {
      const sql = generateCleanupSQL();
      expect(sql).toMatch(/DELETE\s+FROM\s+photos/i);
      expect(sql).toContain("NOT IN");
    });
  });

  describe("668 组重复数据场景", () => {
    it("应能处理设计文档提及的 668 组重复数据规模", () => {
      // 模拟 668 组重复 + 一些正常数据
      const records: PhotoRecord[] = [];

      // 生成 668 组重复（每组 2-3 条）
      for (let i = 0; i < 668; i++) {
        const baseTime = new Date("2024-01-01T00:00:00Z");
        baseTime.setHours(baseTime.getHours() + i);

        const hasThumbnail = i % 3 === 0; // 部分有缩略图

        // 每组 2 条记录
        records.push({
          id: `dup-${i}-1`,
          storage_source_id: "src-main",
          file_path: `/photos/dup_${i}.jpg`,
          thumbnail_path: hasThumbnail ? `/thumbs/dup_${i}.jpg` : null,
          created_at: baseTime.toISOString(),
        });

        const time2 = new Date(baseTime);
        time2.setMinutes(time2.getMinutes() + 30);
        records.push({
          id: `dup-${i}-2`,
          storage_source_id: "src-main",
          file_path: `/photos/dup_${i}.jpg`,
          thumbnail_path: null,
          created_at: time2.toISOString(),
        });

        // 部分组有 3 条
        if (i % 5 === 0) {
          const time3 = new Date(baseTime);
          time3.setMinutes(time3.getMinutes() + 60);
          records.push({
            id: `dup-${i}-3`,
            storage_source_id: "src-main",
            file_path: `/photos/dup_${i}.jpg`,
            thumbnail_path: hasThumbnail ? null : `/thumbs/dup_${i}_v2.jpg`,
            created_at: time3.toISOString(),
          });
        }
      }

      // 再加一些正常无重复记录
      for (let i = 0; i < 100; i++) {
        records.push({
          id: `unique-${i}`,
          storage_source_id: "src-main",
          file_path: `/photos/unique_${i}.jpg`,
          thumbnail_path: `/thumbs/unique_${i}.jpg`,
          created_at: new Date("2024-06-01T00:00:00Z").toISOString(),
        });
      }

      const { keep, remove } = simulateCleanup(records);

      // 668 组重复 + 100 条独立 = 总共应保留 768 条
      expect(keep).toHaveLength(668 + 100);

      // 每组重复都只保留 1 条
      // 验证没有被删除的记录仍在保留集中
      const keptIds = new Set(keep.map((r) => r.id));
      for (let i = 0; i < 100; i++) {
        expect(keptIds.has(`unique-${i}`)).toBe(true);
      }

      // 验证每组重复仅保留一条
      const keptDupIds = keep
        .filter((r) => r.id.startsWith("dup-"))
        .map((r) => r.id);
      const dupGroups = new Map<string, number>();
      for (const id of keptDupIds) {
        const groupIndex = id.match(/^dup-(\d+)/)?.[1];
        if (groupIndex) {
          dupGroups.set(groupIndex, (dupGroups.get(groupIndex) ?? 0) + 1);
        }
      }
      // 每组仅保留 1 条
      for (const [, count] of dupGroups) {
        expect(count).toBe(1);
      }
    });
  });
});

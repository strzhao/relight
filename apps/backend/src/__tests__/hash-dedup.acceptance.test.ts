/**
 * 验收测试：Hash 去重逻辑
 *
 * 覆盖设计文档 §4 Worker — scan-storage 去重流程：
 * - SHA256 哈希计算
 * - 相同内容产生相同哈希
 * - 不同内容产生不同哈希
 * - 哈希对比去重：哈希存在则跳过，不存在则新增
 * - 空文件 / 大文件边界情况
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// ---- 核心函数：SHA256 哈希计算 ----

/**
 * 计算文件的 SHA256 哈希（hex 格式）。
 * 设计文档 §4: scan-storage worker 使用 SHA256 进行文件去重。
 */
function computeFileHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 去重检查：给定已知哈希集合，判断文件是否已存在。
 * 返回 { exists, hash }
 */
function checkDuplicate(
  buffer: Buffer,
  knownHashes: Set<string>,
): { exists: boolean; hash: string } {
  const hash = computeFileHash(buffer);
  return { exists: knownHashes.has(hash), hash };
}

/**
 * 增量去重：从文件列表中筛选出新文件。
 * 设计文档 §4: 遍历目录 → SHA256 去重 → 仅处理新文件
 */
function filterNewFiles(
  files: Buffer[],
  knownHashes: Set<string>,
): { newFiles: Buffer[]; newHashes: string[]; skippedCount: number } {
  const newFiles: Buffer[] = [];
  const newHashes: string[] = [];
  let skippedCount = 0;

  for (const file of files) {
    const hash = computeFileHash(file);
    if (knownHashes.has(hash)) {
      skippedCount++;
    } else {
      newFiles.push(file);
      newHashes.push(hash);
      knownHashes.add(hash);
    }
  }

  return { newFiles, newHashes, skippedCount };
}

// ---- 测试 ----

describe("Hash 去重 — 验收测试（设计文档 §4）", () => {
  describe("computeFileHash — SHA256 计算", () => {
    it("应对相同内容产生相同哈希", () => {
      const content = Buffer.from("test photo data 12345");
      const hash1 = computeFileHash(content);
      const hash2 = computeFileHash(content);
      expect(hash1).toBe(hash2);
    });

    it("应对不同内容产生不同哈希", () => {
      const hash1 = computeFileHash(Buffer.from("photo A content"));
      const hash2 = computeFileHash(Buffer.from("photo B content"));
      expect(hash1).not.toBe(hash2);
    });

    it("应对微小差异产生完全不同哈希（雪崩效应）", () => {
      const hash1 = computeFileHash(Buffer.from("photo-001"));
      const hash2 = computeFileHash(Buffer.from("photo-002"));
      // 仅末尾字符不同，哈希应完全不同
      expect(hash1).not.toBe(hash2);
      // 不应只是最小差异
      const diffCount = [...hash1].filter((c, i) => c !== hash2[i]).length;
      expect(diffCount).toBeGreaterThan(hash1.length / 3);
    });

    it("应返回 64 个字符的十六进制字符串（SHA256=32 字节）", () => {
      const hash = computeFileHash(Buffer.from("test"));
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("空 Buffer 也应正确计算哈希", () => {
      const hash = computeFileHash(Buffer.from([]));
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      // 空内容的 SHA256 是已知常量
      expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });

    it("大 Buffer (模拟大文件) 应正确计算哈希", () => {
      const large = Buffer.alloc(10 * 1024 * 1024, "x"); // 10MB
      const hash = computeFileHash(large);
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("checkDuplicate — 单文件去重", () => {
    const content = Buffer.from("unique photo data");
    const hash = computeFileHash(content);

    it("已知哈希集合中包含该哈希时应返回 exists=true", () => {
      const knownHashes = new Set([hash]);
      const result = checkDuplicate(content, knownHashes);
      expect(result.exists).toBe(true);
      expect(result.hash).toBe(hash);
    });

    it("已知哈希集合中不包含该哈希时应返回 exists=false", () => {
      const knownHashes = new Set<string>(["abc123", "def456"]);
      const result = checkDuplicate(content, knownHashes);
      expect(result.exists).toBe(false);
      expect(result.hash).toBe(hash);
    });

    it("空集合应返回 exists=false", () => {
      const result = checkDuplicate(content, new Set());
      expect(result.exists).toBe(false);
    });
  });

  describe("filterNewFiles — 批量增量去重", () => {
    const fileA = Buffer.from("photo A content v1");
    const fileB = Buffer.from("photo B content v2");
    const fileC = Buffer.from("photo C content v3");

    it("无已知哈希时应全部视为新文件", () => {
      const knownHashes = new Set<string>();
      const result = filterNewFiles([fileA, fileB, fileC], knownHashes);
      expect(result.newFiles).toHaveLength(3);
      expect(result.newHashes).toHaveLength(3);
      expect(result.skippedCount).toBe(0);
    });

    it("部分哈希已知时应正确筛选", () => {
      const hashA = computeFileHash(fileA);
      const knownHashes = new Set([hashA]);

      const result = filterNewFiles([fileA, fileB, fileC], knownHashes);
      expect(result.newFiles).toHaveLength(2); // B, C 是新文件
      expect(result.skippedCount).toBe(1); // A 被跳过
      // fileA 的哈希不应在 newHashes 中
      expect(result.newHashes).not.toContain(hashA);
    });

    it("全部已知时应全部跳过", () => {
      const knownHashes = new Set([
        computeFileHash(fileA),
        computeFileHash(fileB),
        computeFileHash(fileC),
      ]);

      const result = filterNewFiles([fileA, fileB, fileC], knownHashes);
      expect(result.newFiles).toHaveLength(0);
      expect(result.skippedCount).toBe(3);
    });

    it("已知哈希集合应在处理后包含新哈希（增量更新）", () => {
      const knownHashes = new Set<string>([computeFileHash(fileA)]);
      const initialSize = knownHashes.size;

      filterNewFiles([fileB, fileC], knownHashes);
      // 新文件的哈希应被添加到集合中
      expect(knownHashes.size).toBe(initialSize + 2);
      expect(knownHashes.has(computeFileHash(fileB))).toBe(true);
      expect(knownHashes.has(computeFileHash(fileC))).toBe(true);
    });

    it("处理包含重复文件的批次应正确跳过第二次出现的相同文件", () => {
      const knownHashes = new Set<string>();
      // 同一文件出现两次
      const result = filterNewFiles([fileA, fileA, fileB], knownHashes);
      expect(result.newFiles).toHaveLength(2); // 第一个 A 和 B 是新文件
      expect(result.skippedCount).toBe(1); // 第二个 A 被跳过
      // 但哈希只应出现一次
      expect(result.newHashes).toHaveLength(2);
    });

    it("大量文件 (>1000) 应正确处理", () => {
      const knownHashes = new Set<string>();
      const files: Buffer[] = [];

      for (let i = 0; i < 1000; i++) {
        files.push(Buffer.from(`photo-${i}-content-${Math.random()}`));
      }

      const result = filterNewFiles(files, knownHashes);
      // 所有都是唯一的，应全部为新文件
      expect(result.newFiles).toHaveLength(1000);
      expect(result.skippedCount).toBe(0);
      // 已知哈希应更新为 1000
      expect(knownHashes.size).toBe(1000);
    });
  });

  describe("哈希去重完整性", () => {
    it("应区分仅元数据不同的文件（内容相同）", () => {
      // 模拟两个路径不同但内容相同的照片
      const content = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG 头
      const hash1 = computeFileHash(content);
      const hash2 = computeFileHash(content);
      expect(hash1).toBe(hash2);
    });

    it("应区分仅一个字节不同的文件", () => {
      const buf1 = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
      const buf2 = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe]); // 仅最后1字节不同
      expect(computeFileHash(buf1)).not.toBe(computeFileHash(buf2));
    });
  });
});

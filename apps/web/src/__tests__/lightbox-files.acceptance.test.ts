/**
 * 验收测试：Lightbox 组件文件完整性
 *
 * 覆盖设计文档 — Lightbox 组件清单：
 * - components/ui/lightbox/lightbox-context.tsx   — Context + Provider + useLightbox() hook
 * - components/ui/lightbox/use-lightbox-keys.ts   — 键盘快捷键 hook
 * - components/ui/lightbox/lightbox-controls.tsx  — 顶部栏 + 翻页箭头
 * - components/ui/lightbox/lightbox-info.tsx      — 底部元数据面板
 * - components/ui/lightbox/lightbox-image.tsx     — 图片渲染 + 缩放/平移
 * - components/ui/lightbox/index.tsx              — Lightbox 主组件（无障碍 + 焦点管理）
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ---- Lightbox 目录路径 ----

const LIGHTBOX_DIR = path.resolve(__dirname, "../../components/ui/lightbox");

const REQUIRED_FILES = [
  "lightbox-context.tsx",
  "use-lightbox-keys.ts",
  "lightbox-controls.tsx",
  "lightbox-info.tsx",
  "lightbox-image.tsx",
  "index.tsx",
] as const;

// ---- 测试 ----

describe("Lightbox 组件文件完整性 — 验收测试", () => {
  describe("目录存在性", () => {
    it("components/ui/lightbox/ 目录应存在", () => {
      expect(fs.existsSync(LIGHTBOX_DIR)).toBe(true);
    });

    it("components/ui/lightbox/ 应为目录", () => {
      if (fs.existsSync(LIGHTBOX_DIR)) {
        const stat = fs.statSync(LIGHTBOX_DIR);
        expect(stat.isDirectory()).toBe(true);
      }
    });
  });

  describe("文件完整性", () => {
    it.each([...REQUIRED_FILES])("应包含文件 %s", (filename) => {
      const filePath = path.join(LIGHTBOX_DIR, filename);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("所有 6 个文件均应存在", () => {
      const existingFiles = REQUIRED_FILES.filter((f) => fs.existsSync(path.join(LIGHTBOX_DIR, f)));
      expect(existingFiles).toHaveLength(6);
    });

    it("每个文件应为非空文件", () => {
      for (const filename of REQUIRED_FILES) {
        const filePath = path.join(LIGHTBOX_DIR, filename);
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          expect(stat.size).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("主入口导出", () => {
    it("index.tsx 应导出 Lightbox 组件", async () => {
      const indexPath = path.join(LIGHTBOX_DIR, "index.tsx");
      // 只有在文件存在时才测试导入
      if (fs.existsSync(indexPath)) {
        const mod = await import(indexPath);
        // 应导出 Lightbox 默认导出或命名导出
        const hasLightbox =
          typeof mod.default !== "undefined" || typeof mod.Lightbox !== "undefined";
        expect(hasLightbox).toBe(true);
      }
    });
  });
});

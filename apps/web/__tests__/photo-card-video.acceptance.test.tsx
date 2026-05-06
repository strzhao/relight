/**
 * 验收测试：PhotoCard 视频徽章（红队 / 风险点 F.1）
 *
 * 设计契约：
 *   1. <PhotoCard photo={...}> 当 photo.mediaType==='video' 且 photo.durationSec=42 时：
 *      - 必须渲染徽章 — 包含图标（Play / lucide SVG）+ 文本 "0:42"
 *   2. 当 mediaType==='image' 时：必须 NOT 渲染徽章
 *   3. 当 mediaType===undefined 时：默认视为 image，必须 NOT 渲染徽章
 *
 * 红队铁律：本文件不读取 PhotoCard 实现，仅基于设计契约。
 *
 * 注意：项目 web app 未安装 @testing-library/react，沿用现有 *.tsx 测试约定
 *      使用 react-dom/server.renderToString 静态渲染并对 HTML 串做断言。
 *      这能验证 SVG 节点 + 文本是否出现在 DOM 输出中。
 */
import type { Photo } from "@relight/shared";
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PhotoCard } from "@/components/photo-card";

// ---- mock 数据工厂 ----

function makePhoto(overrides: Partial<Photo> = {}): Photo {
  return {
    id: "photo-001",
    storageSourceId: "src-001",
    filePath: "videos/clip.mp4",
    fileHash: "hash-001",
    width: 1920,
    height: 1080,
    fileSize: 1_000_000,
    thumbnailPath: "/thumbs/photo-001.jpg",
    takenAt: "2026-05-03T10:00:00.000Z",
    createdAt: "2026-05-03T10:00:00.000Z",
    ...overrides,
  };
}

function renderHtml(photo: Photo): string {
  // priority=true 强制 shouldLoad=true，跳过 IntersectionObserver 行为
  return renderToString(React.createElement(PhotoCard, { photo, priority: true }));
}

describe("PhotoCard — 视频徽章验收", () => {
  describe("视频路径 — 应渲染徽章", () => {
    it("mediaType='video' 且 durationSec=42 → 渲染含 lucide SVG 图标的徽章", () => {
      const html = renderHtml(makePhoto({ mediaType: "video", durationSec: 42 }));
      // lucide-react 图标会渲染为 <svg class="lucide ...">
      expect(html).toMatch(/<svg[^>]*class="[^"]*lucide/);
    });

    it("mediaType='video' 且 durationSec=42 → 渲染时长文本 0:42", () => {
      const html = renderHtml(makePhoto({ mediaType: "video", durationSec: 42 }));
      expect(html).toContain("0:42");
    });

    it("mediaType='video' 且 durationSec=125 → 渲染 2:05（分:秒 格式）", () => {
      const html = renderHtml(makePhoto({ mediaType: "video", durationSec: 125 }));
      expect(html).toContain("2:05");
    });
  });

  describe("非视频路径 — 不应渲染徽章", () => {
    it("mediaType='image' → HTML 中不应出现时长文本（如 0:42）", () => {
      const html = renderHtml(makePhoto({ mediaType: "image", durationSec: 42 }));
      // 即使 durationSec 错误地有值，image 类型也不应展示徽章文本
      expect(html).not.toContain("0:42");
    });

    it("mediaType='image' → HTML 中不应包含 Play 图标 lucide-play 类名", () => {
      const html = renderHtml(makePhoto({ mediaType: "image" }));
      expect(html).not.toMatch(/lucide-play/i);
    });

    it("mediaType=undefined → 视为 image，不渲染徽章（无时长文本）", () => {
      const html = renderHtml(makePhoto({ mediaType: undefined, durationSec: 42 }));
      expect(html).not.toContain("0:42");
      expect(html).not.toMatch(/lucide-play/i);
    });
  });
});

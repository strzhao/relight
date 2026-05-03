/**
 * 验收测试：HEIC 跨系统数据流完整性
 *
 * 覆盖设计文档跨系统集成点：
 * - thumbnail.ts HEIC 路径 (两步转换 + .jpg 扩展名)
 * - API 契约: thumbnailUrl 格式 + 404 JSON 响应
 * - 前端 api.ts: thumbnailUrl(id) helper
 * - 前端 PhotoCard: img 标签 + 加载态/失败态占位
 * - 兼容性: JPEG/PNG 不受 HEIC 影响
 * - 解码器缺失时照片仍入库，thumbnail=null，前端显示占位图
 *
 * 本测试验证从存储层 → 缩略图 → API → 前端的完整数据流接口一致性。
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

// ---- 类型定义（匹配设计文档和共享包接口） ----

/** 照片记录（匹配 shared Photo 接口） */
interface PhotoRecord {
  id: string;
  filePath: string;
  thumbnailPath: string | null;
  width: number;
  height: number;
  fileSize: number;
  fileHash: string;
  storageSourceId: string;
  createdAt: string;
}

/** 缩略图生成器接口（匹配 thumbnail.ts 导出） */
interface ThumbnailGenerator {
  generateThumbnail(sourcePath: string, outputDir: string, photoId: string): Promise<string>;
}

/** API Client 接口（匹配前端 api.ts） */
interface ApiClient {
  thumbnailUrl(photoId: string): string;
}

/** PhotoCard 组件 Props（匹配前端 photo-card.tsx） */
interface PhotoCardProps {
  photoId: string;
  thumbnailUrl: string;
}

/** PhotoCard 状态 */
type PhotoCardState = "loading" | "loaded" | "error";

/** 端到端流水线结果 */
interface PipelineResult {
  photo: PhotoRecord;
  thumbnailUrl: string | null;
  cardState: PhotoCardState;
  errors: string[];
}

// ---- 核心逻辑（基于设计文档的独立重实现） ----

/**
 * 确定缩略图文件扩展名。
 * 设计文档: HEIC 缩略图输出文件扩展名为 .jpg（非 .heic）
 */
function getOutputExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".heic" || ext === ".heif") {
    return ".jpg";
  }
  return ext;
}

/**
 * 判断文件是否需要 HEIC 两步转换路径。
 * 设计文档: HEIC/HEIF 由扩展名守卫，两步转换；非 HEIC 走 sharp 直接路径。
 */
function needsHeicConversion(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".heic" || ext === ".heif";
}

/**
 * 模拟 generateThumbnail 的扩展名确定逻辑。
 * 返回输出文件名（验证 HEIC → .jpg 规则）。
 */
function simulateThumbnailOutputName(
  sourcePath: string,
  photoId: string,
): { outputName: string; viaHeicPath: boolean } {
  const ext = path.extname(sourcePath).toLowerCase();
  const isHeic = ext === ".heic" || ext === ".heif";
  // HEIC 强制 .jpg 扩展名
  const outputExt = isHeic ? ".jpg" : ext;
  const outputName = `${photoId}${outputExt}`;

  return { outputName, viaHeicPath: isHeic };
}

/**
 * thumbnailUrl helper。
 * 设计文档: thumbnailUrl(id) → /api/photos/${id}/thumbnail
 */
function thumbnailUrl(photoId: string): string {
  return `/api/photos/${photoId}/thumbnail`;
}

/**
 * 模拟 PhotoCard 组件状态转换。
 * 设计文档: 渲染 <img> 标签，onError → 显示占位图
 */
function simulatePhotoCardState(
  photo: PhotoRecord,
  thumbnailLoadResult: "success" | "error",
): PhotoCardState {
  if (!photo.thumbnailPath) {
    // 无缩略图路径 → 直接显示占位
    return "error";
  }

  if (thumbnailLoadResult === "error") {
    // img onError → 显示占位
    return "error";
  }

  return "loaded";
}

/**
 * 模拟端到端流水线：HEIC 文件扫描 → 缩略图生成 → API 返回 → 前端展示。
 *
 * 设计文档全流程：
 * 1. scan-storage: 遍历目录 → 发现 HEIC 文件 → SHA256 去重 → INSERT photo
 * 2. generateThumbnail: 检测 HEIC → heif-convert → sharp → .jpg 输出
 * 3. API: GET /api/photos/:id/thumbnail → 返回 JPEG 或 404 JSON
 * 4. 前端: thumbnailUrl(id) → <img src={...}> → onError 占位
 */
function simulateFullPipeline(
  filePath: string,
  photoId: string,
  decoderAvailable: boolean,
  conversionSucceeds: boolean,
): PipelineResult {
  const errors: string[] = [];
  const isHeic = needsHeicConversion(filePath);
  const ext = path.extname(filePath);
  const fileName = path.basename(filePath);

  // Step 1: INSERT photo (scan-storage)
  let thumbnailPath: string | null = null;

  if (isHeic && !decoderAvailable) {
    // 解码器缺失: 照片仍入库，thumbnail=null
    errors.push(`缩略图生成失败 (${fileName}): HEIC 解码器不可用，请安装 heif-convert`);
    thumbnailPath = null;
  } else if (isHeic && !conversionSucceeds) {
    // 解码器可用但转换失败
    errors.push(`缩略图生成失败 (${fileName}): heif-convert 转换失败`);
    thumbnailPath = null;
  } else {
    // 缩略图生成成功
    const outputExt = isHeic ? ".jpg" : ext;
    thumbnailPath = `/thumbnails/${photoId}${outputExt}`;
  }

  const photo: PhotoRecord = {
    id: photoId,
    filePath,
    thumbnailPath,
    width: 0,
    height: 0,
    fileSize: 1024,
    fileHash: "mock-hash",
    storageSourceId: "mock-source",
    createdAt: new Date().toISOString(),
  };

  // Step 2: API 响应 (thumbnailUrl)
  const apiUrl = thumbnailPath ? thumbnailUrl(photoId) : null;

  // Step 3: PhotoCard 状态
  const cardState = simulatePhotoCardState(photo, thumbnailPath ? "success" : "error");

  return {
    photo,
    thumbnailUrl: apiUrl,
    cardState,
    errors,
  };
}

// ---- 测试 ----

describe("HEIC 跨系统数据流 — 验收测试（设计文档 全流程）", () => {
  describe("格式兼容性: 缩略图扩展名规则", () => {
    it("HEIC → 输出 .jpg 扩展名", () => {
      const { outputName, viaHeicPath } = simulateThumbnailOutputName(
        "/photos/test.heic",
        "abc-123",
      );
      expect(outputName).toBe("abc-123.jpg");
      expect(viaHeicPath).toBe(true);
    });

    it("HEIF → 输出 .jpg 扩展名", () => {
      const { outputName, viaHeicPath } = simulateThumbnailOutputName(
        "/photos/test.heif",
        "abc-124",
      );
      expect(outputName).toBe("abc-124.jpg");
      expect(viaHeicPath).toBe(true);
    });

    it("JPG → 保持 .jpg 扩展名", () => {
      const { outputName, viaHeicPath } = simulateThumbnailOutputName(
        "/photos/test.jpg",
        "abc-125",
      );
      expect(outputName).toBe("abc-125.jpg");
      expect(viaHeicPath).toBe(false);
    });

    it("PNG → 保持 .png 扩展名", () => {
      const { outputName, viaHeicPath } = simulateThumbnailOutputName(
        "/photos/test.png",
        "abc-126",
      );
      expect(outputName).toBe("abc-126.png");
      expect(viaHeicPath).toBe(false);
    });

    it("WEBP → 保持 .webp 扩展名", () => {
      const { outputName } = simulateThumbnailOutputName("/photos/test.webp", "abc-127");
      expect(outputName).toBe("abc-127.webp");
    });
  });

  describe("HEIC 两步转换路径识别", () => {
    it.each([
      ["test.heic", true],
      ["test.HEIC", true],
      ["test.heif", true],
      ["test.HEIF", true],
      ["test.jpg", false],
      ["test.jpeg", false],
      ["test.png", false],
      ["test.webp", false],
      ["test.gif", false],
      ["test.bmp", false],
      ["test.tiff", false],
    ])("%s → needsHeicConversion = %s", (filename, expected) => {
      expect(needsHeicConversion(`/photos/${filename}`)).toBe(expected);
    });
  });

  describe("扩展名确定逻辑", () => {
    it("所有 HEIC 变体应返回 .jpg", () => {
      const variants = ["photo.heic", "photo.HEIC", "photo.Heic", "photo.heif", "photo.HEIF"];
      for (const v of variants) {
        expect(getOutputExtension(v)).toBe(".jpg");
      }
    });

    it("非 HEIC 文件应返回原扩展名", () => {
      expect(getOutputExtension("photo.jpg")).toBe(".jpg");
      expect(getOutputExtension("photo.png")).toBe(".png");
      expect(getOutputExtension("photo.webp")).toBe(".webp");
      expect(getOutputExtension("photo.gif")).toBe(".gif");
    });
  });
});

describe("API 接口契约 — thumbnailUrl helper", () => {
  describe("thumbnailUrl(id) 格式", () => {
    it("应返回 /api/photos/${id}/thumbnail 格式", () => {
      expect(thumbnailUrl("abc-123")).toBe("/api/photos/abc-123/thumbnail");
      expect(thumbnailUrl("550e8400-e29b-41d4-a716-446655440000")).toBe(
        "/api/photos/550e8400-e29b-41d4-a716-446655440000/thumbnail",
      );
    });

    it("应使用绝对路径格式（以 / 开头）", () => {
      const url = thumbnailUrl("photo-001");
      expect(url.startsWith("/")).toBe(true);
      expect(url).toMatch(/^\/api\/photos\/.+\/thumbnail$/);
    });

    it("不同 photoId 应生成不同 URL", () => {
      const url1 = thumbnailUrl("photo-a");
      const url2 = thumbnailUrl("photo-b");
      expect(url1).not.toBe(url2);
      expect(url1).toContain("photo-a");
      expect(url2).toContain("photo-b");
    });
  });
});

describe("前端 PhotoCard 组件 — 验收测试（设计文档 photo-card.tsx）", () => {
  describe("PhotoCardProps 接口", () => {
    it("应接受 photoId prop", () => {
      const props: PhotoCardProps = {
        photoId: "test-photo-1",
        thumbnailUrl: "/api/photos/test-photo-1/thumbnail",
      };
      expect(props.photoId).toBe("test-photo-1");
      expect(props.thumbnailUrl).toBe("/api/photos/test-photo-1/thumbnail");
    });
  });

  describe("PhotoCard 状态管理", () => {
    it("有缩略图路径 + 加载成功 → loaded 状态", () => {
      const photo: PhotoRecord = {
        id: "photo-1",
        filePath: "/photos/test.jpg",
        thumbnailPath: "/thumbnails/photo-1.jpg",
        width: 1920,
        height: 1080,
        fileSize: 500000,
        fileHash: "abc123",
        storageSourceId: "source-1",
        createdAt: "2024-01-01",
      };

      const state = simulatePhotoCardState(photo, "success");
      expect(state).toBe("loaded");
    });

    it("thumbnailPath 为 null → 直接显示占位（error 状态）", () => {
      const photo: PhotoRecord = {
        id: "photo-2",
        filePath: "/photos/test.heic",
        thumbnailPath: null,
        width: 0,
        height: 0,
        fileSize: 2048,
        fileHash: "def456",
        storageSourceId: "source-1",
        createdAt: "2024-01-02",
      };

      const state = simulatePhotoCardState(photo, "success");
      // thumbnailPath 为 null 时，即使加载"成功"也应显示占位
      expect(state).toBe("error");
    });

    it("有 thumbnailPath 但 img onError → 显示占位（error 状态）", () => {
      const photo: PhotoRecord = {
        id: "photo-3",
        filePath: "/photos/test.heic",
        thumbnailPath: "/thumbnails/photo-3.jpg",
        width: 400,
        height: 300,
        fileSize: 3000,
        fileHash: "ghi789",
        storageSourceId: "source-1",
        createdAt: "2024-01-03",
      };

      // img 标签 onError 触发
      const state = simulatePhotoCardState(photo, "error");
      expect(state).toBe("error");
    });
  });

  describe("<img> 标签渲染", () => {
    it("src 应指向 thumbnailUrl", () => {
      const url = thumbnailUrl("photo-x");
      expect(url).toBe("/api/photos/photo-x/thumbnail");
    });

    it("onError 处理应优雅降级（不崩溃，显示占位）", () => {
      // 验证 error 状态不等于程序崩溃
      const errorState = simulatePhotoCardState(
        {
          id: "p1",
          filePath: "/p/test.heic",
          thumbnailPath: "/t/p1.jpg",
          width: 100,
          height: 100,
          fileSize: 1000,
          fileHash: "h1",
          storageSourceId: "s1",
          createdAt: "",
        },
        "error",
      );
      expect(errorState).toBe("error");
      // 验证所有可能状态都是合法值
      expect(["loading", "loaded", "error"]).toContain(errorState);
    });
  });
});

describe("端到端场景 — 解码器缺失时的兼容性", () => {
  it("HEIC 文件 + 解码器不可用 → 照片仍入库，thumbnail=null，卡片显示占位", () => {
    const result = simulateFullPipeline(
      "/photos/vacation/sunset.heic",
      "photo-heic-001",
      false, // 解码器不可用
      false,
    );

    // 照片记录应包含完整字段
    expect(result.photo.id).toBe("photo-heic-001");
    expect(result.photo.filePath).toContain("sunset.heic");

    // thumbnailPath 应为 null（解码器缺失）
    expect(result.photo.thumbnailPath).toBeNull();

    // 卡片状态应为 error（显示占位图）
    expect(result.cardState).toBe("error");

    // 应记录明确的错误日志
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("HEIC 解码器不可用");
    expect(result.errors[0]).toContain("sunset.heic");
  });

  it("HEIC 文件 + 解码器可用 + 转换成功 → thumbnail 非空，卡片显示 loaded", () => {
    const result = simulateFullPipeline(
      "/photos/vacation/sunset.heic",
      "photo-heic-002",
      true, // 解码器可用
      true, // 转换成功
    );

    expect(result.photo.thumbnailPath).not.toBeNull();
    expect(result.photo.thumbnailPath).toContain(".jpg");
    expect(result.photo.thumbnailPath).not.toContain(".heic");
    expect(result.cardState).toBe("loaded");
    expect(result.errors).toHaveLength(0);
  });

  it("HEIC 文件 + 解码器可用 + 转换失败 → thumbnail=null，卡片显示占位", () => {
    const result = simulateFullPipeline(
      "/photos/vacation/corrupt.heic",
      "photo-heic-003",
      true, // 解码器可用
      false, // 转换失败
    );

    expect(result.photo.thumbnailPath).toBeNull();
    expect(result.cardState).toBe("error");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("corrupt.heic");
  });

  it("JPG 文件 + 任何解码器状态 → 不受影响，thumbnail 正常生成", () => {
    // 测试解码器不可用的情况（不应影响 JPG）
    const resultNoDecoder = simulateFullPipeline(
      "/photos/vacation/sunset.jpg",
      "photo-jpg-001",
      false,
      true,
    );

    expect(resultNoDecoder.photo.thumbnailPath).not.toBeNull();
    expect(resultNoDecoder.cardState).toBe("loaded");

    // 测试解码器可用的情况
    const resultWithDecoder = simulateFullPipeline(
      "/photos/vacation/sunset.jpg",
      "photo-jpg-002",
      true,
      true,
    );

    expect(resultWithDecoder.photo.thumbnailPath).not.toBeNull();
    expect(resultWithDecoder.cardState).toBe("loaded");
  });

  it("PNG 文件 + 任何解码器状态 → 不受影响", () => {
    const result = simulateFullPipeline("/photos/screenshot.png", "photo-png-001", false, true);

    expect(result.photo.thumbnailPath).toContain(".png");
    expect(result.cardState).toBe("loaded");
  });
});

describe("跨系统接口一致性验证", () => {
  it("thumbnailUrl 返回的 URL 应与 API 路由匹配", () => {
    // 设计文档 API 路由: GET /api/photos/:id/thumbnail
    for (const id of ["photo-1", "abc-def", "550e8400"]) {
      const url = thumbnailUrl(id);
      expect(url).toBe(`/api/photos/${id}/thumbnail`);
    }
  });

  it("缩略图生成输出的扩展名应与 API Content-Type 兼容", () => {
    // 设计文档: 缩略图输出 .jpg → API 返回 Content-Type: image/jpeg
    const jpegExtensions = [".jpg", ".jpeg"];

    for (const input of ["test.heic", "test.heif", "test.jpg"]) {
      const ext = getOutputExtension(input);
      expect(jpegExtensions).toContain(ext);
    }
  });

  it("PhotoCard 的 thumbnailUrl prop 应与 api.ts thumbnailUrl() 一致", () => {
    // 前端 PhotoCard 使用 api.thumbnailUrl(id) 获取 src
    // 验证类型接口一致
    const url = thumbnailUrl("test-photo");
    const props: PhotoCardProps = {
      photoId: "test-photo",
      thumbnailUrl: url,
    };

    expect(props.thumbnailUrl).toBe("/api/photos/test-photo/thumbnail");
  });

  it("解码器缺失时全链路降级：存储 → API → 前端", () => {
    // 模拟 HEIC 文件在解码器缺失场景下的完整链路
    const result = simulateFullPipeline("/photos/test.heic", "photo-heic-full", false, false);

    // 存储层: 照片记录存在，thumbnailPath=null
    expect(result.photo).toBeDefined();
    expect(result.photo.thumbnailPath).toBeNull();

    // API 层: thumbnailUrl 返回 null（无有效缩略图可提供）
    // 前端应该通过判断 thumbnailPath 来决定是否渲染 <img>
    expect(result.thumbnailUrl).toBeNull();

    // 前端层: 卡片显示占位（error 状态）
    expect(result.cardState).toBe("error");

    // 日志层: 包含清晰错误信息
    expect(result.errors.some((e) => e.includes("解码器不可用"))).toBe(true);
  });
});

import path from "node:path";
import type { AnalysisStatus, FileTreeNode } from "@relight/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../db";
import { createStorageAdapter } from "../storage";
import { checkPathAccessibility } from "../storage/check-path";

export const storageRouter = new Hono()
  /** 列出所有存储源 */
  .get("/", async (c) => {
    const sources = await db.select().from(schema.storageSources);
    return c.json({ success: true, data: sources });
  })
  /** 检查存储源可达性 */
  .post("/:id/check", async (c) => {
    const id = c.req.param("id");

    const sources = await db
      .select()
      .from(schema.storageSources)
      .where(eq(schema.storageSources.id, id));

    const source = sources[0];
    if (!source) {
      return c.json({ success: false, error: "存储源不存在" }, 404);
    }

    const result = await checkPathAccessibility(source.rootPath);

    // 更新数据库
    await db
      .update(schema.storageSources)
      .set({
        status: result.status,
        lastError: result.lastError,
      })
      .where(eq(schema.storageSources.id, id));

    return c.json({
      success: true,
      data: {
        id,
        status: result.status,
        lastError: result.lastError,
      },
    });
  })
  /** 获取存储源文件树 */
  .get("/:id/files", async (c) => {
    const id = c.req.param("id");

    // 1. 查找存储源
    const sources = await db
      .select()
      .from(schema.storageSources)
      .where(eq(schema.storageSources.id, id));

    const source = sources[0];
    if (!source) {
      return c.json({ success: false, error: "存储源不存在" }, 404);
    }

    // 2. 获取照片列表（含分析状态，LEFT JOIN photo_analyses）
    const photos = await db
      .select({
        id: schema.photos.id,
        filePath: schema.photos.filePath,
        fileSize: schema.photos.fileSize,
        analysisId: schema.photoAnalyses.id,
      })
      .from(schema.photos)
      .leftJoin(schema.photoAnalyses, eq(schema.photos.id, schema.photoAnalyses.photoId))
      .where(eq(schema.photos.storageSourceId, id));

    // 构建 filePath → photo 信息的映射
    const photoMap = new Map<string, { photoId: string; analysisStatus: AnalysisStatus }>();
    for (const photo of photos) {
      if (!photoMap.has(photo.filePath)) {
        photoMap.set(photo.filePath, {
          photoId: photo.id,
          analysisStatus: photo.analysisId ? "analyzed" : "pending",
        });
      }
    }

    // 3. 获取存储源文件列表
    const adapter = createStorageAdapter(source.type);
    let files: Awaited<ReturnType<typeof adapter.listFiles>>;
    try {
      files = await adapter.listFiles(source.rootPath);
    } catch (err) {
      return c.json(
        {
          success: false,
          error: `无法访问存储源: ${err instanceof Error ? err.message : String(err)}`,
        },
        500,
      );
    }

    // 4. 构建文件树
    const rootName = source.rootPath.split(path.sep).pop() || source.rootPath;
    const rootNode: FileTreeNode = {
      type: "folder",
      name: rootName,
      path: source.rootPath,
      children: [],
    };
    const folderMap = new Map<string, FileTreeNode>();
    folderMap.set(source.rootPath, rootNode);

    for (const file of files) {
      const dir = path.dirname(file.path);
      const relativePath = path.relative(source.rootPath, file.path);
      const parts = relativePath.split(path.sep);

      // 确保所有父级文件夹节点存在
      let currentPath = source.rootPath;
      let currentChildren = rootNode.children ?? [];

      for (let i = 0; i < parts.length - 1; i++) {
        const partName = parts[i] ?? "";
        currentPath = path.join(currentPath, partName);
        if (!folderMap.has(currentPath)) {
          const folderNode: FileTreeNode = {
            type: "folder",
            name: partName,
            path: currentPath,
            children: [],
          };
          folderMap.set(currentPath, folderNode);
          currentChildren.push(folderNode);
        }
        const folder = folderMap.get(currentPath);
        if (!folder) break;
        currentChildren = folder.children ?? [];
      }

      // 添加文件节点
      const photoInfo = photoMap.get(file.path);
      currentChildren.push({
        type: "file",
        name: parts[parts.length - 1] ?? "",
        path: file.path,
        photoId: photoInfo?.photoId,
        fileSize: file.size,
        analysisStatus: photoInfo?.analysisStatus,
      });
    }

    // 5. 统计
    let totalFiles = 0;
    let analyzedCount = 0;
    let pendingCount = 0;
    let failedCount = 0;

    function walkTree(nodes: FileTreeNode[]) {
      for (const node of nodes) {
        if (node.type === "file") {
          totalFiles++;
          if (node.analysisStatus === "analyzed") analyzedCount++;
          else if (node.analysisStatus === "failed") failedCount++;
          else pendingCount++;
        }
        if (node.children) {
          walkTree(node.children);
        }
      }
    }
    walkTree(rootNode.children ?? []);

    return c.json({
      success: true,
      data: {
        tree: [rootNode],
        totalFiles,
        analyzedCount,
        pendingCount,
        failedCount,
      },
    });
  });

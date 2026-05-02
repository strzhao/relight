import { RefreshButton } from "@/components/admin/refresh-button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getPhotoAnalyses } from "@/lib/admin-data";
import type { PhotoAnalysisItem } from "@relight/shared";
import Link from "next/link";

interface PhotosPageProps {
  searchParams: Promise<{ page?: string; sortBy?: string }>;
}

export default async function AdminPhotosPage({ searchParams }: PhotosPageProps) {
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const sortBy = params.sortBy === "aestheticScore" ? "aestheticScore" : "processedAt";
  const pageSize = 20;

  let data: { data: PhotoAnalysisItem[]; total: number; page: number; pageSize: number } | null =
    null;
  let error: string | null = null;

  try {
    data = await getPhotoAnalyses(page, pageSize, sortBy);
  } catch (err) {
    error = err instanceof Error ? err.message : "获取分析列表失败";
  }

  const totalPages = data ? Math.ceil(data.total / pageSize) : 0;

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">照片分析</h2>
          <p className="text-sm text-muted-foreground">
            所有 AI 分析记录，共 {data?.total ?? 0} 条
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">排序:</span>
            <Link
              href={`/admin/photos?sortBy=processedAt&page=1`}
              className={
                sortBy === "processedAt"
                  ? "font-medium text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }
            >
              时间
            </Link>
            <span className="text-muted-foreground">|</span>
            <Link
              href={`/admin/photos?sortBy=aestheticScore&page=1`}
              className={
                sortBy === "aestheticScore"
                  ? "font-medium text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }
            >
              评分
            </Link>
          </div>
          <RefreshButton />
        </div>
      </div>

      {/* 错误状态 */}
      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="flex items-center gap-3 pt-6">
            <span className="text-destructive text-sm">获取数据失败：{error}</span>
          </CardContent>
        </Card>
      )}

      {/* 表格 */}
      {data ? (
        data.data.length === 0 ? (
          <div className="rounded-lg border py-12 text-center text-sm text-muted-foreground">
            暂无分析记录，请先触发扫描和分析
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">文件路径</th>
                    <th className="px-4 py-3 text-left font-medium">AI 模型</th>
                    <th className="px-4 py-3 text-left font-medium">评分</th>
                    <th className="px-4 py-3 text-left font-medium">简述</th>
                    <th className="px-4 py-3 text-left font-medium">时间</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.data.map((item) => (
                    <tr key={item.id} className="hover:bg-muted/30">
                      <td className="max-w-48 truncate px-4 py-3 font-mono text-xs">
                        {item.filePath}
                      </td>
                      <td className="px-4 py-3">{item.aiModel}</td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            item.aestheticScore != null && item.aestheticScore >= 8
                              ? "font-semibold text-green-600"
                              : ""
                          }
                        >
                          {item.aestheticScore ?? "-"}
                        </span>
                      </td>
                      <td className="max-w-64 truncate px-4 py-3 text-muted-foreground">
                        {item.narrative ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(item.processedAt).toLocaleString("zh-CN")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 分页 */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-2">
                {page > 1 && (
                  <Link
                    href={`/admin/photos?sortBy=${sortBy}&page=${page - 1}`}
                    className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    上一页
                  </Link>
                )}
                <span className="text-sm text-muted-foreground">
                  {page} / {totalPages}
                </span>
                {page < totalPages && (
                  <Link
                    href={`/admin/photos?sortBy=${sortBy}&page=${page + 1}`}
                    className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    下一页
                  </Link>
                )}
              </div>
            )}
          </>
        )
      ) : (
        <Skeleton className="h-64 w-full rounded-lg" />
      )}
    </div>
  );
}

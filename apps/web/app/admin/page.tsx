import { RefreshButton } from "@/components/admin/refresh-button";
import { StatsCard } from "@/components/admin/stats-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getAdminStats } from "@/lib/admin-data";
import type { AdminStats } from "@relight/shared";
import { BarChart3, CheckCircle2, FolderOpen, Image } from "lucide-react";
import Link from "next/link";

export default async function AdminDashboardPage() {
  let stats: AdminStats | null = null;
  let error: string | null = null;

  try {
    stats = await getAdminStats();
  } catch (err) {
    error = err instanceof Error ? err.message : "获取统计数据失败";
  }

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">仪表盘</h2>
          <p className="text-sm text-muted-foreground">照片分析系统运行概况</p>
        </div>
        <RefreshButton />
      </div>

      {/* 错误状态 */}
      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="flex items-center gap-3 pt-6">
            <span className="text-destructive text-sm">获取数据失败：{error}</span>
          </CardContent>
        </Card>
      )}

      {/* 统计卡片 */}
      {stats ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <StatsCard
              title="照片总数"
              value={stats.totalPhotos}
              description={`来自 ${stats.storageSources.length} 个存储源`}
              icon={Image}
            />
            <StatsCard
              title="已分析"
              value={stats.analyzedPhotos}
              description={
                stats.totalPhotos > 0
                  ? `覆盖率 ${Math.round((stats.analyzedPhotos / stats.totalPhotos) * 100)}%`
                  : "暂无照片"
              }
              icon={BarChart3}
            />
            <StatsCard
              title="平均评分"
              value={stats.avgAestheticScore}
              description="10 分制美学评分"
              icon={CheckCircle2}
            />
            <StatsCard
              title="通过率"
              value={`${Math.round(stats.passRate * 100)}%`}
              description="评分 >= 8 的比例"
              icon={FolderOpen}
            />
          </div>

          {/* 存储源卡片 */}
          <div>
            <h3 className="mb-3 text-lg font-semibold">存储源</h3>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {stats.storageSources.map((source) => (
                <Card key={source.id}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm">{source.name}</span>
                      <Badge variant="secondary" className="text-xs">
                        {source.type}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-1 text-sm text-muted-foreground">
                    <p>
                      照片: {source.photoCount} / 已分析: {source.analyzedCount}
                    </p>
                    <p>
                      最后扫描:{" "}
                      {source.lastScanAt
                        ? new Date(source.lastScanAt).toLocaleString("zh-CN")
                        : "从未"}
                    </p>
                    <div className="pt-2">
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`/admin/photos?storageSourceId=${source.id}`}>查看详情</Link>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          {/* 最近分析表格 */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-semibold">最近分析</h3>
              <Link href="/admin/photos" className="text-sm text-primary hover:underline">
                查看全部
              </Link>
            </div>
            {stats.recentAnalyses.length === 0 ? (
              <div className="rounded-lg border py-12 text-center text-sm text-muted-foreground">
                暂无分析记录
              </div>
            ) : (
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
                    {stats.recentAnalyses.map((item) => (
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
            )}
          </div>
        </>
      ) : (
        !error && (
          /* 加载骨架 */
          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map(() => {
                const id = crypto.randomUUID();
                return (
                  <Card key={id}>
                    <CardHeader className="pb-2">
                      <Skeleton className="h-4 w-20" />
                    </CardHeader>
                    <CardContent>
                      <Skeleton className="h-8 w-16" />
                      <Skeleton className="mt-2 h-3 w-32" />
                    </CardContent>
                  </Card>
                );
              })}
            </div>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map(() => {
                const id = crypto.randomUUID();
                return (
                  <Card key={id}>
                    <CardHeader className="pb-2">
                      <Skeleton className="h-4 w-24" />
                    </CardHeader>
                    <CardContent>
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="mt-2 h-4 w-3/4" />
                    </CardContent>
                  </Card>
                );
              })}
            </div>
            <Skeleton className="h-48 w-full rounded-lg" />
          </div>
        )
      )}
    </div>
  );
}

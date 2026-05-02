import { RefreshButton } from "@/components/admin/refresh-button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getHealthDetails } from "@/lib/admin-data";
import { cn } from "@/lib/utils";
import type { HealthDetails } from "@relight/shared";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

const statusIconMap = {
  healthy: CheckCircle2,
  degraded: AlertTriangle,
  unhealthy: XCircle,
};

const statusColorMap = {
  healthy: "text-green-600",
  degraded: "text-yellow-600",
  unhealthy: "text-red-600",
};

const statusLabelMap = {
  healthy: "正常",
  degraded: "降级",
  unhealthy: "异常",
};

export default async function AdminHealthPage() {
  let health: HealthDetails | null = null;
  let error: string | null = null;

  try {
    health = await getHealthDetails();
  } catch (err) {
    error = err instanceof Error ? err.message : "获取健康状态失败";
  }

  const OverallIcon = health ? statusIconMap[health.overall] : XCircle;

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">系统健康</h2>
          <p className="text-sm text-muted-foreground">各组件连接状态检查</p>
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

      {/* 整体状态 */}
      {health && (
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 pb-2">
            <OverallIcon className={cn("size-5", statusColorMap[health.overall])} />
            <div>
              <span className="font-semibold">整体状态: </span>
              <span className={cn("font-medium", statusColorMap[health.overall])}>
                {statusLabelMap[health.overall]}
              </span>
            </div>
          </CardHeader>
        </Card>
      )}

      {/* 组件状态卡片 */}
      {health ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {health.components.map((comp) => {
            const Icon = statusIconMap[comp.status];
            return (
              <Card key={comp.component}>
                <CardHeader className="flex flex-row items-center gap-3 pb-3">
                  <Icon className={cn("size-5", statusColorMap[comp.status])} />
                  <div>
                    <span className="font-medium text-sm capitalize">{comp.component}</span>
                  </div>
                </CardHeader>
                <CardContent>
                  <span className={cn("text-sm font-medium", statusColorMap[comp.status])}>
                    {statusLabelMap[comp.status]}
                  </span>
                  {comp.message && (
                    <p className="mt-1 text-xs text-muted-foreground">{comp.message}</p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        !error && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={`skeleton-health-${i}`}>
                <CardContent className="space-y-3 pt-6">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-5 w-12" />
                  <Skeleton className="h-3 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        )
      )}
    </div>
  );
}

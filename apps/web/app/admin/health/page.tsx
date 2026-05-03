import { RefreshButton } from "@/components/admin/refresh-button";
import { StatsCard } from "@/components/admin/stats-card";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getHealthDetails } from "@/lib/admin-data";
import { cn, formatBytes, formatUptime } from "@/lib/utils";
import type { HealthDetails } from "@relight/shared";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Database,
  HardDrive,
  MemoryStick,
  Terminal,
  XCircle,
} from "lucide-react";

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

      {/* ========== 分区 1: 服务健康 ========== */}
      <div>
        <h3 className="mb-3 text-lg font-semibold">服务健康</h3>
        <p className="-mt-2 mb-4 text-sm text-muted-foreground">核心组件连接状态检查</p>

        {health ? (
          <>
            {/* 整体状态横幅 */}
            <Card className="mb-4">
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

            {/* 4 个组件卡片 */}
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
          </>
        ) : (
          !error && (
            <div className="space-y-4">
              <Skeleton className="h-16 w-full rounded-lg" />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholder
                  <Card key={`skeleton-health-${i}`}>
                    <CardContent className="space-y-3 pt-6">
                      <Skeleton className="h-4 w-20" />
                      <Skeleton className="h-5 w-12" />
                      <Skeleton className="h-3 w-full" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )
        )}
      </div>

      {/* ========== 分区 2: 系统资源 ========== */}
      <div>
        <h3 className="mb-3 text-lg font-semibold">系统资源</h3>
        <p className="-mt-2 mb-4 text-sm text-muted-foreground">CPU、内存、进程运行状态</p>

        {health ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatsCard
              title="CPU 负载"
              value={`${(health.system.cpu.loadAvg[0] ?? 0).toFixed(1)}`}
              description={`${health.system.cpu.cores} 核心 · ${health.system.cpu.model}`}
              icon={Cpu}
            />
            <StatsCard
              title="系统内存"
              value={`${health.system.memory.usagePercent}%`}
              description={`已用 ${formatBytes(health.system.memory.used)} / ${formatBytes(health.system.memory.total)}`}
              icon={MemoryStick}
            />
            <StatsCard
              title="进程运行时间"
              value={formatUptime(health.system.process.uptime)}
              description={`PID: ${health.system.process.pid} · Node ${health.system.process.nodeVersion}`}
              icon={Terminal}
            />
            <StatsCard
              title="进程内存 RSS"
              value={formatBytes(health.system.process.memoryRss)}
              description={`堆 ${formatBytes(health.system.process.memoryHeapUsed)} / ${formatBytes(health.system.process.memoryHeapTotal)}`}
              icon={Terminal}
            />
          </div>
        ) : (
          !error && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholder
                <Card key={`skeleton-system-${i}`}>
                  <CardHeader className="pb-2">
                    <Skeleton className="h-4 w-20" />
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-8 w-16" />
                    <Skeleton className="mt-2 h-3 w-32" />
                  </CardContent>
                </Card>
              ))}
            </div>
          )
        )}
      </div>

      {/* ========== 分区 3: 磁盘 ========== */}
      <div>
        <h3 className="mb-3 text-lg font-semibold">磁盘存储</h3>
        <p className="-mt-2 mb-4 text-sm text-muted-foreground">数据库文件大小及磁盘空间使用情况</p>

        {health ? (
          health.disk ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <StatsCard
                title="数据库文件"
                value={formatBytes(health.disk.dbFile.sizeBytes)}
                description={health.disk.dbFile.path}
                icon={Database}
              />
              <StatsCard
                title="磁盘剩余空间"
                value={
                  health.disk.freeSpaceBytes != null
                    ? formatBytes(health.disk.freeSpaceBytes)
                    : "N/A"
                }
                description={
                  health.disk.freeSpaceBytes != null && health.disk.totalSpaceBytes != null
                    ? `可用 ${formatBytes(health.disk.freeSpaceBytes)} / 总共 ${formatBytes(health.disk.totalSpaceBytes)}`
                    : "无法获取磁盘信息"
                }
                icon={HardDrive}
              />
            </div>
          ) : (
            <Card className="border-dashed">
              <CardContent className="flex items-center gap-3 pt-6">
                <Database className="size-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  数据库文件未找到，无法获取磁盘信息
                </span>
              </CardContent>
            </Card>
          )
        ) : (
          !error && (
            <div className="grid gap-4 sm:grid-cols-2">
              {Array.from({ length: 2 }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholder
                <Card key={`skeleton-disk-${i}`}>
                  <CardHeader className="pb-2">
                    <Skeleton className="h-4 w-20" />
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-8 w-16" />
                    <Skeleton className="mt-2 h-3 w-40" />
                  </CardContent>
                </Card>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}

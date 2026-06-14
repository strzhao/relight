"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { API_ROUTES } from "@relight/shared";
import { Clock, Image, Loader2, MapPin, Utensils } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { ChangeEvent } from "react";
import { useCallback, useEffect, useState } from "react";

interface PluginInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  params: { key: string; label: string; type: string; required?: boolean }[];
}

interface TaskRecord {
  id: string;
  pluginId: string;
  status: string;
  params: string | null;
  result: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

const defaultStatusBadge = { label: "未知", className: "bg-muted text-muted-foreground" };

const statusBadgeMap: Record<string, { label: string; className: string }> = {
  pending: { label: "等待中", className: "bg-muted text-muted-foreground" },
  running: { label: "运行中", className: "bg-status-active text-white" },
  done: { label: "已完成", className: "bg-status-completed text-white" },
  failed: { label: "失败", className: "bg-destructive text-white" },
};

function getStatusBadge(status: string) {
  return statusBadgeMap[status] ?? defaultStatusBadge;
}

function getResultPhotoCount(result: string | null): number {
  if (!result) return 0;
  try {
    const parsed = JSON.parse(result);
    return parsed?.stats?.selected ?? parsed?.photos?.length ?? 0;
  } catch {
    return 0;
  }
}

interface TaskDisplayInfo {
  timeStart: string;
  timeEnd: string;
  gpsLat: number | null;
  gpsLng: number | null;
  photoCount: number;
  clustersFound: number;
  firstPhotoPath: string | null;
}

function parseTaskDisplayInfo(task: TaskRecord): TaskDisplayInfo | null {
  if (!task.result) return null;
  try {
    const r = JSON.parse(task.result);
    const selectedCluster = r.clusters?.find((c: { isSelected: boolean }) => c.isSelected);
    const gps = selectedCluster?.gpsCenter;
    return {
      timeStart: r.timeWindow?.start ?? "",
      timeEnd: r.timeWindow?.end ?? "",
      gpsLat: gps ? Math.round(gps.lat * 10000) / 10000 : null,
      gpsLng: gps ? Math.round(gps.lng * 10000) / 10000 : null,
      photoCount: r.stats?.selected ?? r.photos?.length ?? 0,
      clustersFound: r.stats?.clustersFound ?? 0,
      firstPhotoPath: r.photos?.[0]?.outputPath ?? null,
    };
  } catch {
    return null;
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      // Try "YYYY-MM-DD HH:MM:SS" format
      const parts = iso.split(" ");
      return parts[1] ?? iso;
    }
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export default function PluginDetailPage() {
  const params = useParams();
  const pluginId = params.pluginId as string;

  const [plugin, setPlugin] = useState<PluginInfo | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_URL}${API_ROUTES.plugins.detail(pluginId)}`);
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? "获取插件信息失败");
        return;
      }
      setPlugin(body.data.plugin);
      setTasks(body.data.recentTasks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络错误");
    } finally {
      setLoading(false);
    }
  }, [pluginId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Poll for running task status
  useEffect(() => {
    if (!runningTaskId) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(
          `${BASE_URL}${API_ROUTES.plugins.taskDetail(pluginId, runningTaskId)}`,
        );
        const body = await res.json();
        if (!body.success) return;
        const task = body.data as TaskRecord;
        if (task.status === "done" || task.status === "failed") {
          setRunning(false);
          setRunningTaskId(null);
          fetchData(); // refresh
          clearInterval(timer);
        }
      } catch {
        // ignore poll errors
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [runningTaskId, pluginId, fetchData]);

  const handleRun = async () => {
    if (!plugin) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_URL}${API_ROUTES.plugins.run(plugin.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formValues),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? "运行失败");
        setRunning(false);
        return;
      }
      setRunningTaskId(body.data.taskId);
      // Refresh task list immediately
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络错误");
      setRunning(false);
    }
  };

  const handleInputChange = (key: string, e: ChangeEvent<HTMLInputElement>) => {
    setFormValues((prev) => ({ ...prev, [key]: e.target.value }));
  };

  const Icon = Utensils;

  return (
    <div className="space-y-6" data-testid="plugin-detail">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/admin/plugins"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          插件
        </Link>
        <span className="text-sm text-muted-foreground">/</span>
        <span className="text-sm font-medium">
          {loading ? "加载中..." : (plugin?.name ?? pluginId)}
        </span>
      </div>

      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="flex items-center gap-3 pt-6">
            <span className="text-destructive text-sm">{error}</span>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-96" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      ) : plugin ? (
        <>
          {/* Plugin info */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                  <Icon className="size-5 text-primary" />
                </div>
                <div>
                  <h2 className="text-xl font-bold">{plugin.name}</h2>
                  <p className="text-sm text-muted-foreground">{plugin.description}</p>
                </div>
              </div>
            </CardHeader>
          </Card>

          {/* Run form */}
          <Card>
            <CardHeader>
              <h3 className="font-semibold">运行参数</h3>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                {plugin.params.map((param) => (
                  <div key={param.key} className="space-y-2">
                    <label
                      htmlFor={param.key}
                      className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                    >
                      {param.label}
                      {param.required && <span className="text-destructive ml-0.5">*</span>}
                    </label>
                    <input
                      id={param.key}
                      name={param.key}
                      type={param.type}
                      value={formValues[param.key] ?? ""}
                      onChange={(e) => handleInputChange(param.key, e)}
                      data-testid={`param-${param.key}`}
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
                    />
                  </div>
                ))}
              </div>
              <Button onClick={handleRun} disabled={running} data-testid="run-button">
                {running ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    运行中...
                  </>
                ) : (
                  "运行"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Task history — card grid */}
          <div>
            <h3 className="font-semibold mb-4">历史任务</h3>
            {tasks.length === 0 ? (
              <div className="rounded-lg border py-8 text-center text-sm text-muted-foreground">
                暂无任务记录
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {tasks.map((task) => {
                  const sb = getStatusBadge(task.status);
                  const info = parseTaskDisplayInfo(task);
                  return (
                    <Card
                      key={task.id}
                      className="hover:shadow-md transition-shadow"
                      data-testid="task-item"
                    >
                      {/* Thumbnail area */}
                      <div className="aspect-[16/9] bg-muted/50 rounded-t-xl overflow-hidden flex items-center justify-center">
                        {info?.firstPhotoPath ? (
                          <img
                            src={`http://localhost:3000/api/plugins/${pluginId}/tasks/${task.id}/photos/0`}
                            alt=""
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = "none";
                              (e.target as HTMLImageElement).nextElementSibling?.classList.remove(
                                "hidden",
                              );
                            }}
                          />
                        ) : null}
                        <div
                          className={
                            info?.firstPhotoPath
                              ? "hidden"
                              : "flex flex-col items-center gap-2 text-muted-foreground"
                          }
                        >
                          <Image className="size-10" />
                          <span className="text-xs">无预览</span>
                        </div>
                      </div>
                      <CardContent className="pt-4 space-y-2">
                        {/* Time */}
                        <div className="flex items-center gap-2 text-sm">
                          <Clock className="size-3.5 text-muted-foreground shrink-0" />
                          <span className="truncate">
                            {info
                              ? `${formatTime(info.timeStart)} ~ ${formatTime(info.timeEnd)}`
                              : new Date(task.createdAt).toLocaleString("zh-CN")}
                          </span>
                        </div>
                        {/* GPS */}
                        {info?.gpsLat != null && (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <MapPin className="size-3.5 shrink-0" />
                            <span className="truncate">
                              {info.gpsLat}, {info.gpsLng}
                            </span>
                          </div>
                        )}
                        {/* Stats */}
                        {info && (
                          <div className="flex items-center gap-3 text-sm text-muted-foreground">
                            <span>{info.photoCount} 张照片</span>
                            <span>·</span>
                            <span>{info.clustersFound} 个聚类</span>
                          </div>
                        )}
                        {/* Error message for failed tasks */}
                        {task.status === "failed" && task.error && (
                          <p className="text-xs text-destructive truncate">
                            {task.error.slice(0, 60)}
                          </p>
                        )}
                        {/* Status + action */}
                        <div className="flex items-center justify-between pt-3 border-t">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                              sb.className,
                            )}
                          >
                            {sb.label}
                          </span>
                          {task.status === "done" && getResultPhotoCount(task.result) > 0 && (
                            <Button variant="outline" size="sm" asChild>
                              <Link href={`/admin/plugins/${plugin.id}/tasks/${task.id}`}>
                                查看照片
                              </Link>
                            </Button>
                          )}
                          {task.status === "running" && (
                            <Loader2 className="size-4 animate-spin text-muted-foreground" />
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="rounded-lg border py-12 text-center text-sm text-muted-foreground">
          插件不存在
        </div>
      )}
    </div>
  );
}

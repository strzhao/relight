import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { API_ROUTES } from "@relight/shared";
import { Utensils } from "lucide-react";
import Link from "next/link";

interface PluginInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  params: { key: string; label: string; type: string; required?: boolean }[];
}

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

async function getPlugins(): Promise<PluginInfo[]> {
  const res = await fetch(`${BASE_URL}${API_ROUTES.plugins.list}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`获取插件列表失败: ${res.status}`);
  const body = await res.json();
  if (!body.success) throw new Error(body.error ?? "未知错误");
  return body.data as PluginInfo[];
}

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  utensils: Utensils,
};

export default async function PluginsPage() {
  let plugins: PluginInfo[] = [];
  let error: string | null = null;

  try {
    plugins = await getPlugins();
  } catch (err) {
    error = err instanceof Error ? err.message : "获取插件列表失败";
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">插件</h2>
        <p className="text-sm text-muted-foreground">扩展功能模块，按需运行</p>
      </div>

      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="flex items-center gap-3 pt-6">
            <span className="text-destructive text-sm">获取数据失败：{error}</span>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {plugins.map((plugin) => {
          const Icon = iconMap[plugin.icon] ?? Utensils;
          return (
            <Link key={plugin.id} href={`/admin/plugins/${plugin.id}`} data-testid="plugin-card">
              <Card className="h-full transition-shadow hover:shadow-md cursor-pointer">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                      <Icon className="size-5 text-primary" />
                    </div>
                    <span className="font-semibold">{plugin.name}</span>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{plugin.description}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {plugin.params.map((param) => {
                      return (
                        <span
                          key={param.key}
                          className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium text-muted-foreground"
                        >
                          {param.label}
                          {param.required && <span className="ml-0.5 text-destructive">*</span>}
                        </span>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      {!error && plugins.length === 0 && (
        <div className="rounded-lg border py-12 text-center text-sm text-muted-foreground">
          暂无可用插件
        </div>
      )}
    </div>
  );
}

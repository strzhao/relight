"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ApiResponse, DailyPick } from "@relight/shared";
import { useEffect, useState } from "react";

type State =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "content"; pick: DailyPick };

export function DailyHero() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await api.daily.today();
        if (cancelled) return;
        if (res.success && res.data) {
          setState({ status: "content", pick: res.data });
        } else {
          setState({ status: "empty" });
        }
      } catch (e) {
        if (cancelled) return;
        setState({
          status: "error",
          message: e instanceof Error ? e.message : "加载失败",
        });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // 加载态
  if (state.status === "loading") {
    return (
      <Card className="overflow-hidden">
        <Skeleton className="aspect-[4/3] w-full" />
        <CardHeader>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="mt-1 h-4 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="mt-2 h-4 w-3/4" />
        </CardContent>
      </Card>
    );
  }

  // 空态
  if (state.status === "empty") {
    return (
      <Card className="overflow-hidden">
        <div className="flex aspect-[4/3] items-center justify-center bg-muted">
          <div className="text-center text-muted-foreground">
            <p className="text-lg">今日精选</p>
            <p className="mt-1 text-sm">AI 将每日为你挑选最值得回忆的瞬间</p>
          </div>
        </div>
      </Card>
    );
  }

  // 错误态
  if (state.status === "error") {
    return (
      <Card className="overflow-hidden border-destructive/50">
        <div className="flex aspect-[4/3] items-center justify-center bg-muted">
          <div className="text-center text-muted-foreground">
            <p className="text-lg">加载失败</p>
            <p className="mt-1 text-sm text-destructive">{state.message}</p>
          </div>
        </div>
      </Card>
    );
  }

  // 内容态
  const { pick } = state;

  return (
    <Card className="overflow-hidden">
      {/* 照片缩略图 */}
      <div className="relative aspect-[4/3] bg-muted">
        {pick.photo ? (
          <img
            src={api.thumbnailUrl(pick.photoId)}
            alt={pick.title}
            className={cn("h-full w-full object-cover")}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            照片不可用
          </div>
        )}
        {/* 评分标签 */}
        <div className="absolute right-3 top-3 rounded-md bg-background/80 px-2 py-0.5 text-sm font-medium backdrop-blur-sm">
          {pick.score.toFixed(1)} 分
        </div>
      </div>

      <CardHeader>
        <h2 className="text-xl font-semibold">{pick.title}</h2>
        <p className="text-sm text-muted-foreground">{pick.pickDate}</p>
      </CardHeader>

      <CardContent>
        <p className="text-sm leading-relaxed text-muted-foreground">{pick.narrative}</p>
      </CardContent>
    </Card>
  );
}

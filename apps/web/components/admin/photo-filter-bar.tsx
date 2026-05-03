"use client";

import { Button } from "@/components/ui/button";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

interface StorageSourceOption {
  id: string;
  name: string;
}

interface PhotoFilterBarProps {
  storageSources: StorageSourceOption[];
  total: number;
}

const sortOptions: { value: string; label: string }[] = [
  { value: "createdAt", label: "创建时间" },
  { value: "takenAt", label: "拍摄时间" },
  { value: "fileSize", label: "文件大小" },
  { value: "aestheticScore", label: "美学评分" },
  { value: "processedAt", label: "分析时间" },
];

const statusOptions: { value: string; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "analyzed", label: "已分析" },
  { value: "unanalyzed", label: "未分析" },
];

export function PhotoFilterBar({ storageSources, total }: PhotoFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const currentStorageSourceId = searchParams.get("storageSourceId") || "";
  const currentStatus = searchParams.get("analysisStatus") || "all";
  const currentMinScore = searchParams.get("minScore") || "";
  const currentSortBy = searchParams.get("sortBy") || "createdAt";

  const updateParams = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      // 设置新值，空值则删除
      for (const [key, value] of Object.entries(updates)) {
        if (value) {
          params.set(key, value);
        } else {
          params.delete(key);
        }
      }
      // 当筛选条件变化时重置到第 1 页
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams],
  );

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* 存储源筛选 */}
      <select
        value={currentStorageSourceId}
        onChange={(e) => updateParams({ storageSourceId: e.target.value })}
        className="h-9 rounded-md border bg-background px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <option value="">全部存储源</option>
        {storageSources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      {/* 分析状态分段式切换 */}
      <div className="flex rounded-md border p-0.5 bg-muted/50">
        {statusOptions.map((opt) => (
          <Button
            key={opt.value}
            variant={currentStatus === opt.value ? "default" : "ghost"}
            size="sm"
            className="h-7 px-3 text-xs"
            onClick={() => updateParams({ analysisStatus: opt.value === "all" ? "" : opt.value })}
          >
            {opt.label}
          </Button>
        ))}
      </div>

      {/* 最低评分 */}
      <div className="flex items-center gap-1.5">
        <label
          htmlFor="min-score-input"
          className="text-xs text-muted-foreground whitespace-nowrap"
        >
          最低评分
        </label>
        <input
          id="min-score-input"
          type="number"
          min="0"
          max="10"
          step="0.5"
          value={currentMinScore}
          onChange={(e) => updateParams({ minScore: e.target.value })}
          placeholder="0"
          className="h-9 w-16 rounded-md border bg-background px-2 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* 排序 */}
      <select
        value={currentSortBy}
        onChange={(e) => updateParams({ sortBy: e.target.value })}
        className="h-9 rounded-md border bg-background px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {sortOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* 总数 */}
      <span className="ml-auto text-sm text-muted-foreground whitespace-nowrap">
        共 {total} 张照片
      </span>
    </div>
  );
}

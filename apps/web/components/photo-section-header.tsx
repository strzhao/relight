"use client";

import { cn } from "@/lib/utils";

interface PhotoSectionHeaderProps {
  label: string;
  count: number;
  isFirst?: boolean;
}

export function PhotoSectionHeader({ label, count, isFirst = false }: PhotoSectionHeaderProps) {
  return (
    <div
      className={cn(
        "z-10 flex items-center bg-muted/50 px-4 py-2 backdrop-blur-sm",
        !isFirst && "mt-2",
      )}
    >
      <span className="text-sm font-medium">
        {label} <span className="text-muted-foreground">{count}张</span>
      </span>
    </div>
  );
}

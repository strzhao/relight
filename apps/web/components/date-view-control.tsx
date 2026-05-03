"use client";

import { cn } from "@/lib/utils";

export type DateViewMode = "year" | "month" | "day";

interface DateViewControlProps {
  value: DateViewMode;
  onChange: (value: DateViewMode) => void;
}

const options: { value: DateViewMode; label: string }[] = [
  { value: "year", label: "年" },
  { value: "month", label: "月" },
  { value: "day", label: "日" },
];

export function DateViewControl({ value, onChange }: DateViewControlProps) {
  return (
    <div className="inline-flex rounded-md border" role="radiogroup" aria-label="视图切换">
      {options.map((opt) => (
        <label
          key={opt.value}
          className={cn(
            "cursor-pointer px-3 py-1.5 text-sm font-medium transition-colors first:rounded-l-md last:rounded-r-md",
            value === opt.value
              ? "bg-primary text-primary-foreground"
              : "bg-background text-muted-foreground hover:bg-accent",
          )}
        >
          <input
            type="radio"
            name="date-view"
            value={opt.value}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
            className="sr-only"
          />
          {opt.label}
        </label>
      ))}
    </div>
  );
}

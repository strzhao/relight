"use client";

interface PhotoSectionHeaderProps {
  label: string;
  count: number;
}

export function PhotoSectionHeader({ label, count }: PhotoSectionHeaderProps) {
  return (
    <div className="sticky top-0 z-10 flex items-center bg-muted/50 px-4 py-2 backdrop-blur-sm">
      <span className="text-sm font-medium">
        {label} <span className="text-muted-foreground">{count}张</span>
      </span>
    </div>
  );
}

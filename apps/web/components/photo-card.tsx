"use client";

import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { useState } from "react";

interface PhotoCardProps {
  photoId?: string;
  title?: string;
  date?: string;
  tags?: string[];
}

type ImageState = "loading" | "loaded" | "error";

export function PhotoCard({ photoId, title = "照片", date, tags = [] }: PhotoCardProps) {
  const [imageState, setImageState] = useState<ImageState>("loading");

  const thumbnailSrc = photoId ? api.thumbnailUrl(photoId) : null;

  return (
    <Card className="overflow-hidden">
      <div className="aspect-square bg-muted relative">
        {thumbnailSrc && imageState !== "error" && (
          <img
            src={thumbnailSrc}
            alt={title}
            className="absolute inset-0 h-full w-full object-cover"
            style={{ display: imageState === "loaded" ? "block" : "none" }}
            onLoad={() => setImageState("loaded")}
            onError={() => setImageState("error")}
          />
        )}
        {(imageState === "loading" || !thumbnailSrc) && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted">
            <span className="text-xs text-muted-foreground">
              {thumbnailSrc ? "加载中..." : "无缩略图"}
            </span>
          </div>
        )}
        {imageState === "error" && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted">
            <span className="text-xs text-muted-foreground">加载失败</span>
          </div>
        )}
      </div>
      <div className="p-4">
        <h3 className="text-sm font-medium">{title}</h3>
        {date && <p className="mt-1 text-xs text-muted-foreground">{date}</p>}
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

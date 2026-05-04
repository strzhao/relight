"use client";

import { cn } from "@/lib/utils";
import type { Photo } from "@relight/shared";
import { ImageOff } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

interface PhotoCardProps {
  photo: Photo;
  priority?: boolean;
  onClick?: (photo: Photo) => void;
}

export const PhotoCard = memo(function PhotoCard({
  photo,
  priority = false,
  onClick,
}: PhotoCardProps) {
  const [shouldLoad, setShouldLoad] = useState(priority);
  const [hasError, setHasError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (priority) {
      setShouldLoad(true);
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(container);
    return () => observer.disconnect();
  }, [priority]);

  const handleError = useCallback(() => {
    setHasError(true);
  }, []);

  const handleClick = useCallback(() => {
    onClick?.(photo);
  }, [onClick, photo]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "aspect-square relative overflow-hidden rounded-md bg-muted",
        onClick && "cursor-pointer hover:opacity-90 transition-opacity",
      )}
      onClick={onClick ? handleClick : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleClick();
              }
            }
          : undefined
      }
    >
      {shouldLoad && !hasError ? (
        <img
          src={`${API_BASE}/api/photos/${photo.id}/thumbnail`}
          alt=""
          loading={priority ? "eager" : "lazy"}
          className={cn("size-full object-cover")}
          onError={handleError}
        />
      ) : hasError ? (
        <div className="flex size-full items-center justify-center text-muted-foreground">
          <ImageOff className="size-8" />
        </div>
      ) : null}
    </div>
  );
});

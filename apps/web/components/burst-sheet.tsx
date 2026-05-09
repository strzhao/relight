"use client";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Burst, Photo } from "@relight/shared";
import { Check, Layers, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

interface BurstSheetProps {
  open: boolean;
  burstId: string | null;
  onClose: () => void;
  onRepresentativeChanged: (newRepId: string) => void;
}

export function BurstSheet({ open, burstId, onClose, onRepresentativeChanged }: BurstSheetProps) {
  const [members, setMembers] = useState<Photo[] | null>(null);
  const [burst, setBurst] = useState<Burst | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null); // 正在切换的 photoId

  const prevBurstIdRef = useRef<string | null>(null);

  // 监听 open && burstId，拉取成员列表
  useEffect(() => {
    if (!open || !burstId) return;
    if (burstId === prevBurstIdRef.current && members != null) return; // 相同 burst 不重复拉

    prevBurstIdRef.current = burstId;
    setLoading(true);
    setError(null);
    setMembers(null);
    setBurst(null);

    api.bursts
      .members(burstId)
      .then((res) => {
        if (res.success) {
          setMembers(res.data);
          setBurst(res.burst as Burst);
        } else {
          setError("加载连拍成员失败");
        }
      })
      .catch((err: Error) => {
        setError(err.message ?? "加载失败");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open, burstId, members]);

  // 切换代表
  const handleSetRepresentative = useCallback(
    async (photoId: string) => {
      if (!burstId || switching) return;
      setSwitching(photoId);
      setError(null);
      try {
        const res = await api.bursts.setRepresentative(burstId, photoId);
        if (res.success) {
          // 更新 burst 信息
          setBurst((prev) =>
            prev ? { ...prev, representativePhotoId: photoId, manualOverride: true } : prev,
          );
          onRepresentativeChanged(photoId);
        } else {
          setError("切换代表失败");
        }
      } catch (err) {
        setError((err as Error).message ?? "切换代表失败");
      } finally {
        setSwitching(null);
      }
    },
    [burstId, switching, onRepresentativeChanged],
  );

  // 关闭时清理（保留缓存，下次打开同一 burst 不重复拉）
  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // 键盘 Escape 关闭
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, handleClose]);

  const currentRepId = burst?.representativePhotoId;

  return (
    <>
      {/* 遮罩层（button 语义，支持键盘关闭） */}
      <button
        type="button"
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity duration-200 cursor-default",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        onClick={handleClose}
        aria-label="关闭连拍组"
        tabIndex={open ? 0 : -1}
      />

      {/* 底部抽屉（使用原生 dialog 语义元素） */}
      <dialog
        open={open}
        className={cn(
          "fixed bottom-0 left-0 right-0 m-0 max-w-full w-full z-50 flex flex-col rounded-t-xl bg-background shadow-xl border-0 p-0",
          "transition-transform duration-300 ease-in-out",
          "max-h-[80dvh]",
          open ? "translate-y-0" : "translate-y-full",
        )}
        aria-label="连拍组成员"
      >
        {/* 拖拽手柄 */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="h-1 w-10 rounded-full bg-border" />
        </div>

        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 pb-3">
          <div className="flex items-center gap-2">
            <Layers className="size-4 text-muted-foreground" />
            <span className="font-semibold text-sm">
              连拍组
              {burst ? `（共 ${burst.memberCount} 张）` : ""}
            </span>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full p-1.5 hover:bg-muted transition-colors"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-4 pb-6">
          {loading && (
            <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
              <span className="text-sm">加载中...</span>
            </div>
          )}

          {error && !loading && (
            <div className="py-8 text-center text-sm text-destructive">{error}</div>
          )}

          {members && !loading && (
            <>
              <p className="mb-3 text-xs text-muted-foreground">
                点击"设为代表"将该张照片作为候选池和列表展示的代表
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {members.map((photo) => {
                  const isRep = photo.id === currentRepId;
                  const isSwitching = switching === photo.id;

                  return (
                    <div key={photo.id} className="flex flex-col gap-1.5">
                      <div className="relative aspect-square overflow-hidden rounded-md bg-muted">
                        <img
                          src={`${API_BASE}/api/photos/${photo.id}/thumbnail`}
                          alt={photo.filePath.split("/").pop() ?? photo.id}
                          className="size-full object-cover"
                          loading="lazy"
                        />
                        {/* 当前代表标记 */}
                        {isRep && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                            <div className="flex items-center gap-1 rounded-full bg-primary px-2 py-1 text-primary-foreground text-xs font-medium">
                              <Check className="size-3" />
                              代表
                            </div>
                          </div>
                        )}
                      </div>

                      {/* 拍摄时间 */}
                      {photo.takenAt && (
                        <p className="text-xs text-muted-foreground truncate">
                          {new Date(photo.takenAt).toLocaleTimeString("zh-CN", {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </p>
                      )}

                      {/* 设为代表按钮 */}
                      <button
                        type="button"
                        disabled={isRep || isSwitching}
                        onClick={() => handleSetRepresentative(photo.id)}
                        className={cn(
                          "w-full rounded px-2 py-1 text-xs font-medium transition-colors",
                          isRep
                            ? "bg-primary/10 text-primary cursor-default"
                            : "bg-muted hover:bg-secondary text-foreground",
                          isSwitching && "opacity-60 cursor-wait",
                        )}
                      >
                        {isSwitching ? (
                          <span className="flex items-center justify-center gap-1">
                            <Loader2 className="size-3 animate-spin" />
                            切换中
                          </span>
                        ) : isRep ? (
                          "当前代表"
                        ) : (
                          "设为代表"
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </dialog>
    </>
  );
}

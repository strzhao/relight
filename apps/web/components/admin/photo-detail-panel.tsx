"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/lib/utils";
import type {
  AnalysisTag,
  ColorAnalysis,
  CompositionAnalysis,
  EmotionalAnalysis,
  Photo,
  PhotoAnalysis,
  PhotoTag,
  StorageSource,
} from "@relight/shared";
import { API_ROUTES } from "@relight/shared";
import { ChevronDown, ChevronUp, ImageOff, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface PhotoFullDetail extends Photo {
  tags: (PhotoTag & { tagName?: string; tagCategory?: string })[];
  analyses: PhotoAnalysis[];
  storageSource: StorageSource | null;
}

interface PhotoDetailPanelProps {
  photoId: string;
  open: boolean;
  onClose: () => void;
}

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export function PhotoDetailPanel({ photoId, open, onClose }: PhotoDetailPanelProps) {
  const [photo, setPhoto] = useState<PhotoFullDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRawResponse, setShowRawResponse] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    setImgError(false);
    try {
      const res = await fetch(`${BASE_URL}${API_ROUTES.photos.detail(photoId)}`);
      const body = await res.json();
      if (!body.success) throw new Error(body.error ?? "获取照片详情失败");
      setPhoto(body.data as PhotoFullDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "获取照片详情失败");
    } finally {
      setLoading(false);
    }
  }, [photoId]);

  useEffect(() => {
    if (open && photoId) {
      fetchDetail();
    } else {
      setPhoto(null);
      setError(null);
    }
  }, [open, photoId, fetchDetail]);

  // 按处理时间倒序排列分析记录
  const sortedAnalyses = photo
    ? [...photo.analyses].sort(
        (a, b) => new Date(b.processedAt).getTime() - new Date(a.processedAt).getTime(),
      )
    : [];

  const latestAnalysis = sortedAnalyses[0] ?? null;

  if (!open) return null;

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        role="button"
        tabIndex={-1}
      />
      {/* Slide-out panel */}
      <div className="fixed right-0 top-0 z-50 h-full max-w-xl w-full bg-background border-l shadow-2xl overflow-y-auto">
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 z-10 rounded-sm p-1 opacity-70 hover:opacity-100 hover:bg-accent"
        >
          <X className="size-5" />
        </button>

        {/* Loading */}
        {loading && (
          <div className="p-6 space-y-4">
            <Skeleton className="h-64 w-full rounded-lg" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="p-6">
            <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4">
              <span className="text-sm text-destructive">{error}</span>
            </div>
          </div>
        )}

        {/* Content */}
        {photo && !loading && (
          <div className="p-6 space-y-6">
            {/* Thumbnail */}
            <div
              className="rounded-lg overflow-hidden bg-muted relative"
              style={{
                aspectRatio: photo.width && photo.height ? `${photo.width}/${photo.height}` : "4/3",
              }}
            >
              {photo.thumbnailPath && !imgError ? (
                <img
                  src={`/api/photos/${photo.id}/thumbnail`}
                  alt=""
                  className="w-full h-full object-cover"
                  onError={() => setImgError(true)}
                />
              ) : (
                <div className="flex items-center justify-center w-full h-full">
                  <ImageOff className="size-12 text-muted-foreground/50" />
                </div>
              )}
              {/* Score overlay on thumbnail */}
              {latestAnalysis?.aestheticScore != null && (
                <div className="absolute top-3 left-3">
                  <ScoreBadge score={latestAnalysis.aestheticScore} size="lg" />
                </div>
              )}
            </div>

            {/* Metadata */}
            <Card>
              <CardHeader className="pb-2">
                <h3 className="text-sm font-semibold">基本信息</h3>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                <MetaRow label="路径" value={photo.filePath} mono />
                <MetaRow label="尺寸" value={`${photo.width} x ${photo.height}`} />
                <MetaRow label="文件大小" value={formatBytes(photo.fileSize)} />
                <MetaRow
                  label="拍摄时间"
                  value={photo.takenAt ? new Date(photo.takenAt).toLocaleString("zh-CN") : "-"}
                />
                <MetaRow
                  label="录入时间"
                  value={new Date(photo.createdAt).toLocaleString("zh-CN")}
                />
                {photo.storageSource && <MetaRow label="存储源" value={photo.storageSource.name} />}
              </CardContent>
            </Card>

            {/* Analysis Info */}
            {latestAnalysis && (
              <>
                {/* Narrative */}
                {latestAnalysis.narrative && (
                  <Card>
                    <CardHeader className="pb-2">
                      <h3 className="text-sm font-semibold">描述</h3>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {latestAnalysis.narrative}
                      </p>
                    </CardContent>
                  </Card>
                )}

                {/* Tags */}
                {latestAnalysis.tags && latestAnalysis.tags.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <h3 className="text-sm font-semibold">标签</h3>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap gap-1.5">
                        {(latestAnalysis.tags as AnalysisTag[]).map((tag, i) => (
                          <Badge key={`${tag.name}-${i}`} variant="secondary" className="text-xs">
                            {tag.name}
                            <span className="ml-1 text-muted-foreground">
                              {Math.round(tag.confidence * 100)}%
                            </span>
                          </Badge>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Composition */}
                {latestAnalysis.composition && (
                  <AnalysisCard title="构图分析">
                    <CompositionInfo
                      composition={latestAnalysis.composition as CompositionAnalysis}
                    />
                  </AnalysisCard>
                )}

                {/* Color */}
                {latestAnalysis.colorAnalysis && (
                  <AnalysisCard title="色彩分析">
                    <ColorInfo color={latestAnalysis.colorAnalysis as ColorAnalysis} />
                  </AnalysisCard>
                )}

                {/* Emotion */}
                {latestAnalysis.emotionalAnalysis && (
                  <AnalysisCard title="情感分析">
                    <EmotionInfo emotion={latestAnalysis.emotionalAnalysis as EmotionalAnalysis} />
                  </AnalysisCard>
                )}
              </>
            )}

            {/* Analysis History */}
            {sortedAnalyses.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <h3 className="text-sm font-semibold">分析历史 ({sortedAnalyses.length})</h3>
                </CardHeader>
                <CardContent className="space-y-3">
                  {sortedAnalyses.map((analysis) => (
                    <div
                      key={analysis.id}
                      className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                    >
                      <div>
                        <span className="font-medium">{analysis.aiModel}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {new Date(analysis.processedAt).toLocaleString("zh-CN")}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {analysis.aestheticScore != null && (
                          <ScoreBadge score={analysis.aestheticScore} size="sm" />
                        )}
                        {analysis.rawResponse && (
                          <button
                            type="button"
                            onClick={() =>
                              setShowRawResponse(
                                showRawResponse === analysis.id ? null : analysis.id,
                              )
                            }
                            className="text-xs text-muted-foreground hover:text-foreground"
                          >
                            {showRawResponse === analysis.id ? (
                              <ChevronUp className="size-3.5" />
                            ) : (
                              <ChevronDown className="size-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* rawResponse collapsible */}
            {showRawResponse && (
              <Card>
                <CardHeader className="pb-2">
                  <h3 className="text-sm font-semibold">原始响应</h3>
                </CardHeader>
                <CardContent>
                  <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs font-mono">
                    {sortedAnalyses.find((a) => a.id === showRawResponse)?.rawResponse ?? ""}
                  </pre>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function ScoreBadge({
  score,
  size,
}: {
  score: number;
  size: "sm" | "lg";
}) {
  const colorClass =
    score >= 8 ? "text-green-600" : score >= 6 ? "text-yellow-600" : "text-gray-500";

  const sizeClass = size === "lg" ? "text-4xl" : "text-sm";

  return (
    <span className={`font-bold ${colorClass} ${sizeClass} bg-background/80 rounded-md px-1`}>
      {score.toFixed(1)}
    </span>
  );
}

function MetaRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span className={mono ? "font-mono text-xs truncate" : "truncate"}>{value}</span>
    </div>
  );
}

function AnalysisCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <h3 className="text-sm font-semibold">{title}</h3>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function CompositionInfo({ composition }: { composition: CompositionAnalysis }) {
  return (
    <div className="space-y-1.5 text-sm">
      <div className="flex gap-2">
        <span className="text-muted-foreground">类型:</span>
        <span>{composition.type}</span>
      </div>
      <div className="flex gap-2">
        <span className="text-muted-foreground">评分:</span>
        <span>{composition.score}</span>
      </div>
      <div className="flex gap-2">
        <span className="text-muted-foreground">描述:</span>
        <span className="text-muted-foreground">{composition.description}</span>
      </div>
    </div>
  );
}

function ColorInfo({ color }: { color: ColorAnalysis }) {
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">主色:</span>
        <span>{color.dominant}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">情绪:</span>
        <span>{color.mood}</span>
      </div>
      <div>
        <span className="text-muted-foreground text-sm">调色板:</span>
        <div className="flex gap-1 mt-1">
          {color.palette.map((hex) => (
            <div
              key={hex}
              className="size-6 rounded border"
              style={{ backgroundColor: hex }}
              title={hex}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function EmotionInfo({ emotion }: { emotion: EmotionalAnalysis }) {
  return (
    <div className="space-y-1.5 text-sm">
      <div className="flex gap-2">
        <span className="text-muted-foreground">主要:</span>
        <span>{emotion.primary}</span>
      </div>
      <div className="flex gap-2">
        <span className="text-muted-foreground">次要:</span>
        <span>{emotion.secondary}</span>
      </div>
      <div className="flex gap-2">
        <span className="text-muted-foreground">强度:</span>
        <span>{emotion.intensity}</span>
      </div>
    </div>
  );
}

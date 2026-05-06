import { API_ROUTES } from "@relight/shared";
import type { Photo, PhotoAnalysis } from "@relight/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

interface PhotoDetailResponse {
  success: boolean;
  data?: Photo & { analyses?: PhotoAnalysis[] };
  error?: string;
}

async function fetchPhoto(id: string): Promise<Photo & { analysis?: PhotoAnalysis }> {
  const res = await fetch(`${API_BASE}${API_ROUTES.photos.detail(id)}`, { cache: "no-store" });
  if (!res.ok) notFound();
  const json = (await res.json()) as PhotoDetailResponse;
  if (!json.success || !json.data) notFound();
  const { analyses, ...rest } = json.data;
  return { ...rest, analysis: analyses?.[0] };
}

export default async function PhotoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const photo = await fetchPhoto(id);
  const isVideo = (photo.mediaType ?? "image") === "video";
  const hasSubtitles = (photo.analysis?.transcriptSegments?.length ?? 0) > 0;

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <Link href="/photos" className="mb-6 inline-block text-sm text-muted-foreground underline">
        ← 返回照片库
      </Link>

      <div className="overflow-hidden rounded-md bg-muted">
        {isVideo ? (
          <video
            controls
            preload="metadata"
            autoPlay
            src={`${API_BASE}${API_ROUTES.photos.raw(id)}`}
            className="max-h-[80vh] w-full"
          >
            <track
              kind="captions"
              srcLang="zh"
              label="中文"
              src={`${API_BASE}${API_ROUTES.photos.subtitles(id)}`}
              default={hasSubtitles}
            />
          </video>
        ) : (
          <img
            src={`${API_BASE}${API_ROUTES.photos.original(id)}`}
            alt={photo.filePath.split("/").pop() ?? id}
            className="w-full"
          />
        )}
      </div>

      <section className="mt-8 space-y-4">
        {photo.analysis?.narrative && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {photo.analysis.narrative}
          </p>
        )}

        {Array.isArray(photo.analysis?.tags) && photo.analysis.tags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {photo.analysis.tags.map((t) => (
              <span
                key={t.name}
                className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
              >
                {t.name}
              </span>
            ))}
          </div>
        )}

        {isVideo && photo.analysis?.videoPacing && (
          <div>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
              节奏：{photo.analysis.videoPacing}
            </span>
          </div>
        )}

        {isVideo && photo.analysis?.motionScore != null && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">运动感</span>
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full bg-primary"
                style={{
                  width: `${Math.min(100, Math.max(0, (photo.analysis.motionScore / 10) * 100))}%`,
                }}
              />
            </div>
            <span className="text-xs">{photo.analysis.motionScore.toFixed(1)}</span>
          </div>
        )}

        {isVideo && photo.analysis?.transcript && (
          <details className="rounded border p-4">
            <summary className="cursor-pointer text-sm font-medium">完整字幕转录</summary>
            <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
              {photo.analysis.transcript}
            </p>
          </details>
        )}
      </section>
    </main>
  );
}

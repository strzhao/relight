"use client";

import { api, getApiUrl } from "@/lib/api";
import { API_ROUTES, type Person } from "@relight/shared";
import { useEffect, useState } from "react";

interface PersonStripProps {
  /** 可选：仅显示该 storageSource 下的人物（与照片库筛选保持一致） */
  storageSourceId?: string;
  /** 可选：直接传入 persons 数据，跳过内部 fetch（SSR 友好 + 测试友好） */
  persons?: Person[];
  /** 点击头像回调 */
  onPersonClick?: (person: Person) => void;
}

/**
 * /photos 顶部横排圆形头像条。
 *
 * - 优先使用 props.persons（SSR / 测试场景）
 * - 否则按 storageSourceId 拉 displayable=true 的 persons（按 memberCount desc）
 * - 空列表时渲染轻提示，不占太多空间
 */
export function PersonStrip({
  storageSourceId,
  persons: initialPersons,
  onPersonClick,
}: PersonStripProps) {
  const hasInitial = initialPersons !== undefined;
  const [persons, setPersons] = useState<Person[]>(initialPersons ?? []);
  const [loading, setLoading] = useState(!hasInitial);

  useEffect(() => {
    if (hasInitial) return; // 父组件已传 persons，不再 fetch
    let alive = true;
    setLoading(true);
    api.persons
      .list({ storageSourceId })
      .then((res) => {
        if (alive) setPersons(res.data ?? []);
      })
      .catch(() => {
        if (alive) setPersons([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [storageSourceId, hasInitial]);

  if (loading && persons.length === 0) {
    return (
      <div
        aria-hidden="true"
        className="flex shrink-0 gap-3 px-4 py-2 overflow-x-auto"
        data-testid="person-strip-skeleton"
      >
        {Array.from({ length: 4 }, (_, i) => `sk-${i}`).map((id) => (
          <div key={id} className="size-12 shrink-0 animate-pulse rounded-full bg-secondary" />
        ))}
      </div>
    );
  }

  if (persons.length === 0) {
    return (
      <div className="px-4 py-2 text-xs text-muted-foreground" data-testid="person-strip-empty">
        新照片导入后将自动识别人物
      </div>
    );
  }

  return (
    <nav
      aria-label="人物头像导航"
      className="flex shrink-0 items-center gap-3 px-4 py-2 overflow-x-auto"
      data-testid="person-strip"
    >
      {persons.map((p) => (
        <PersonAvatarButton key={p.id} person={p} onClick={() => onPersonClick?.(p)} />
      ))}
    </nav>
  );
}

interface PersonAvatarButtonProps {
  person: Person;
  onClick: () => void;
}

function PersonAvatarButton({ person, onClick }: PersonAvatarButtonProps) {
  const [imgError, setImgError] = useState(false);
  const displayName = person.name ?? `人物 #${person.id.slice(0, 4)}`;
  // 直接走 API_ROUTES + getApiUrl，便于测试 mock（红队 mock 了 getApiUrl）
  const url = getApiUrl(API_ROUTES.persons.avatarImage(person.id));

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${displayName}（${person.memberCount} 张）`}
      aria-label={`${displayName}，${person.memberCount} 张照片`}
      className="group flex shrink-0 flex-col items-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-full"
      data-testid={`person-avatar-${person.id}`}
    >
      <div className="size-12 overflow-hidden rounded-full border border-border bg-secondary">
        {!imgError ? (
          <img
            src={url}
            alt={displayName}
            className="size-full object-cover transition-transform group-hover:scale-105"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-sm font-medium text-muted-foreground">
            {(person.name ?? "?").slice(0, 1)}
          </div>
        )}
      </div>
      <span className="max-w-[64px] truncate text-[10px] text-muted-foreground">{displayName}</span>
    </button>
  );
}

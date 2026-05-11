"use client";

import { api, getApiUrl } from "@/lib/api";
import { API_ROUTES, type Person } from "@relight/shared";
import { EyeOff, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
 * - 否则按 storageSourceId 拉两份：可见 + 已隐藏
 * - 头像右上 EyeOff 按钮 → 隐藏到末尾"已隐藏 (N)"按钮；popover 内可恢复
 */
export function PersonStrip({
  storageSourceId,
  persons: initialPersons,
  onPersonClick,
}: PersonStripProps) {
  const hasInitial = initialPersons !== undefined;
  const [visible, setVisible] = useState<Person[]>(initialPersons ?? []);
  const [hidden, setHidden] = useState<Person[]>([]);
  const [loading, setLoading] = useState(!hasInitial);
  const [hiddenPanelOpen, setHiddenPanelOpen] = useState(false);

  useEffect(() => {
    if (hasInitial) return;
    let alive = true;
    setLoading(true);
    Promise.all([
      api.persons.list({ storageSourceId, hidden: false }),
      api.persons.list({ storageSourceId, hidden: true }),
    ])
      .then(([v, h]) => {
        if (!alive) return;
        setVisible(v.data ?? []);
        setHidden(h.data ?? []);
      })
      .catch(() => {
        if (alive) {
          setVisible([]);
          setHidden([]);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [storageSourceId, hasInitial]);

  async function handleRestore(p: Person) {
    setHidden((prev) => prev.filter((x) => x.id !== p.id));
    setVisible((prev) =>
      [...prev, { ...p, hidden: false }].sort((a, b) => b.memberCount - a.memberCount),
    );
    try {
      await api.persons.update(p.id, { hidden: false });
    } catch {
      setHidden((prev) => [...prev, p]);
      setVisible((prev) => prev.filter((x) => x.id !== p.id));
    }
  }

  if (loading && visible.length === 0 && hidden.length === 0) {
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

  if (visible.length === 0 && hidden.length === 0) {
    return (
      <div className="px-4 py-2 text-xs text-muted-foreground" data-testid="person-strip-empty">
        新照片导入后将自动识别人物
      </div>
    );
  }

  return (
    <nav
      aria-label="人物头像导航"
      className="relative flex shrink-0 items-center gap-3 px-4 py-2 overflow-x-auto"
      data-testid="person-strip"
    >
      {visible.map((p) => (
        <PersonAvatarButton key={p.id} person={p} onClick={() => onPersonClick?.(p)} />
      ))}
      {hidden.length > 0 && (
        <HiddenBucket
          count={hidden.length}
          persons={hidden}
          open={hiddenPanelOpen}
          onToggle={() => setHiddenPanelOpen((v) => !v)}
          onRestore={handleRestore}
          onClose={() => setHiddenPanelOpen(false)}
        />
      )}
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

interface HiddenBucketProps {
  count: number;
  persons: Person[];
  open: boolean;
  onToggle: () => void;
  onRestore: (p: Person) => void;
  onClose: () => void;
}

function HiddenBucket({ count, persons, open, onToggle, onRestore, onClose }: HiddenBucketProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 计算 popover 位置（fixed 定位，避免被父级 overflow 裁剪）
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    function updatePos() {
      if (!triggerRef.current) return;
      const r = triggerRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 8, left: r.left });
    }
    updatePos();
    window.addEventListener("resize", updatePos);
    window.addEventListener("scroll", updatePos, true);
    return () => {
      window.removeEventListener("resize", updatePos);
      window.removeEventListener("scroll", updatePos, true);
    };
  }, [open]);

  // 点外部关闭
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, onClose]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={onToggle}
        title={`已隐藏 ${count} 个人物（点击展开）`}
        aria-label={`已隐藏 ${count} 个人物`}
        aria-expanded={open}
        className="flex shrink-0 flex-col items-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-full"
        data-testid="person-hidden-bucket"
      >
        <div className="flex size-12 items-center justify-center rounded-full border border-dashed border-border bg-secondary text-muted-foreground hover:text-foreground">
          <EyeOff className="size-5" />
        </div>
        <span className="max-w-[64px] truncate text-[10px] text-muted-foreground">
          已隐藏 {count}
        </span>
      </button>
      {open &&
        pos &&
        typeof window !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: "fixed", top: pos.top, left: pos.left }}
            className="z-50 max-h-[60vh] w-64 overflow-y-auto rounded-md border border-border bg-background p-2 shadow-lg"
            data-testid="person-hidden-panel"
          >
            <p className="px-2 py-1 text-xs text-muted-foreground">点「恢复」放回头像条</p>
            {persons.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-secondary"
              >
                {p.avatarPath || p.customAvatarPath ? (
                  <img
                    src={getApiUrl(API_ROUTES.persons.avatarImage(p.id))}
                    alt={p.name ?? "未命名"}
                    className="size-8 shrink-0 rounded-full border border-border object-cover"
                  />
                ) : (
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs text-muted-foreground">
                    ?
                  </div>
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">
                    {p.name ?? `人物 #${p.id.slice(0, 4)}`}
                  </span>
                  <span className="text-xs text-muted-foreground">{p.memberCount} 张</span>
                </div>
                <button
                  type="button"
                  onClick={() => onRestore(p)}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary-foreground/10"
                  data-testid={`person-restore-${p.id}`}
                >
                  <Undo2 className="size-3" />
                  恢复
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

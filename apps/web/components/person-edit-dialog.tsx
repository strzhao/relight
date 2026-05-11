"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { Face, Person, PersonWithMembers, Photo } from "@relight/shared";
import { useEffect, useState } from "react";

interface PersonEditDialogProps {
  open: boolean;
  personId: string | null;
  /** 关闭时回调（不修改 / 修改后都会触发） */
  onClose: () => void;
  /** 持久化成功后回调，便于父级刷新列表 */
  onPersonUpdated?: (person: Person) => void;
  /** 已合并/删除回调，便于父级移除该 person */
  onPersonRemoved?: (personId: string) => void;
}

/**
 * 人物编辑弹窗：改名 / 简介 / 选代表头像 / 合并到其他人。
 */
export function PersonEditDialog({
  open,
  personId,
  onClose,
  onPersonUpdated,
  onPersonRemoved,
}: PersonEditDialogProps) {
  const [detail, setDetail] = useState<PersonWithMembers | null>(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [nickname, setNickname] = useState("");
  const [bio, setBio] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !personId) {
      setDetail(null);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    api.persons
      .detail(personId)
      .then((res) => {
        if (!alive) return;
        setDetail(res.data);
        setName(res.data.name ?? "");
        setNickname(res.data.nickname ?? "");
        setBio(res.data.bio ?? "");
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, personId]);

  async function handleSave() {
    if (!personId || !detail) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.persons.update(personId, {
        name: name === "" ? null : name,
        nickname: nickname === "" ? null : nickname,
        bio: bio === "" ? null : bio,
      });
      onPersonUpdated?.(res.data);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSetRepresentative(face: Face) {
    if (!personId || !detail) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.persons.setRepresentative(personId, { faceId: face.id });
      onPersonUpdated?.(res.data);
      setDetail({
        ...detail,
        representativeFaceId: res.data.representativeFaceId,
        avatarPath: res.data.avatarPath,
        manualOverride: res.data.manualOverride,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleHide() {
    if (!personId) return;
    setSaving(true);
    setError(null);
    try {
      await api.persons.update(personId, { hidden: true });
      onPersonRemoved?.(personId);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleMerge(target: Person) {
    if (!personId || !detail) return;
    const sourceLabel = `${detail.name ?? `人物 #${detail.id.slice(0, 4)}`}（${detail.memberCount} 张）`;
    const targetLabel = `${target.name ?? `人物 #${target.id.slice(0, 4)}`}（${target.memberCount} 张）`;
    const ok = window.confirm(
      `确定把【${sourceLabel}】合并到【${targetLabel}】？\n\n合并后两人的所有照片都归到目标人物，源人物会消失。此操作不可撤销。`,
    );
    if (!ok) return;
    setSaving(true);
    setError(null);
    try {
      await api.persons.merge(personId, { targetPersonId: target.id });
      onPersonRemoved?.(personId);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const displayName = detail?.name ?? (detail ? `人物 #${detail.id.slice(0, 4)}` : "人物");

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="w-[min(560px,90vw)] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle data-testid="person-dialog-title">{displayName}</DialogTitle>
        </DialogHeader>

        {loading && <p className="text-sm text-muted-foreground">加载中…</p>}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {detail && (
          <div className="mt-4 space-y-4">
            {/* 当前代表头像 */}
            <div className="flex items-center gap-3">
              {detail.avatarPath || detail.customAvatarPath ? (
                <img
                  src={api.persons.avatarUrl(detail.id)}
                  alt={displayName}
                  className="size-16 rounded-full border border-border object-cover"
                />
              ) : (
                <div className="flex size-16 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                  ?
                </div>
              )}
              <div className="text-sm text-muted-foreground">共 {detail.memberCount} 张照片</div>
            </div>

            {/* 名称 */}
            <label className="block">
              <span className="text-sm font-medium">姓名</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={20}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                placeholder="未命名"
                data-testid="person-name-input"
              />
            </label>

            {/* 昵称 */}
            <label className="block">
              <span className="text-sm font-medium">昵称</span>
              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                maxLength={20}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                placeholder="可选，比如「奶奶」「小明」"
                data-testid="person-nickname-input"
              />
            </label>

            {/* 简介 */}
            <label className="block">
              <span className="text-sm font-medium">简介</span>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                maxLength={200}
                rows={3}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                placeholder="可选，记录关于这个人的小故事…"
                data-testid="person-bio-input"
              />
              <span className="mt-1 block text-right text-xs text-muted-foreground">
                {bio.length}/200
              </span>
            </label>

            {/* 选代表 face */}
            {detail.faces.length > 0 && (
              <div>
                <p className="mb-2 text-sm font-medium">选择代表头像</p>
                <div className="grid grid-cols-4 gap-2">
                  {detail.faces.slice(0, 16).map((f) => {
                    const photo = detail.photos.find((p) => p.id === f.photoId);
                    const isRep = detail.representativeFaceId === f.id;
                    return (
                      <button
                        type="button"
                        key={f.id}
                        onClick={() => handleSetRepresentative(f)}
                        disabled={saving}
                        className={`relative aspect-square overflow-hidden rounded-md border ${
                          isRep ? "border-primary ring-2 ring-primary" : "border-border"
                        } hover:border-primary`}
                        title={isRep ? "当前代表" : "设为代表"}
                        data-testid={`person-face-${f.id}`}
                      >
                        {photo ? (
                          <img
                            src={api.thumbnailUrl(photo.id)}
                            alt={photo.filePath}
                            className="size-full object-cover"
                          />
                        ) : (
                          <div className="flex size-full items-center justify-center bg-secondary text-xs">
                            ?
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 合并：选另一个 person */}
            <MergeRow
              currentPersonId={detail.id}
              storageSourceId={detail.storageSourceId}
              onMerge={handleMerge}
              disabled={saving}
            />

            {/* 保存 / 隐藏 / 取消 */}
            <div className="flex justify-between gap-2 border-t pt-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleHide}
                disabled={saving}
                data-testid="person-hide-btn"
              >
                从头像条隐藏
              </Button>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={onClose} disabled={saving}>
                  取消
                </Button>
                <Button onClick={handleSave} disabled={saving} data-testid="person-save-btn">
                  保存
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface MergeRowProps {
  currentPersonId: string;
  storageSourceId: string;
  onMerge: (target: Person) => void;
  disabled: boolean;
}

function MergeRow({ currentPersonId, storageSourceId, onMerge, disabled }: MergeRowProps) {
  const [candidates, setCandidates] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.persons
      .list({ storageSourceId })
      .then((res) => {
        if (!alive) return;
        setCandidates(res.data.filter((p) => p.id !== currentPersonId));
      })
      .catch(() => {
        if (alive) setCandidates([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [storageSourceId, currentPersonId]);

  return (
    <div className="border-t pt-4">
      <p className="mb-2 text-sm font-medium">合并到其他人物</p>
      <div className="max-h-64 space-y-1 overflow-y-auto">
        {loading && <p className="px-2 text-xs text-muted-foreground">加载候选中…</p>}
        {!loading && candidates.length === 0 && (
          <p className="px-2 text-xs text-muted-foreground">暂无可合并的候选人物</p>
        )}
        {candidates.map((p) => (
          <button
            type="button"
            key={p.id}
            onClick={() => onMerge(p)}
            disabled={disabled}
            className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary"
            data-testid={`merge-target-${p.id}`}
          >
            {p.avatarPath || p.customAvatarPath ? (
              <img
                src={api.persons.avatarUrl(p.id)}
                alt={p.name ?? "未命名"}
                className="size-9 shrink-0 rounded-full border border-border object-cover"
              />
            ) : (
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-xs text-muted-foreground">
                ?
              </div>
            )}
            <span className="font-medium">{p.name ?? `人物 #${p.id.slice(0, 4)}`}</span>
            <span className="ml-auto text-xs text-muted-foreground">{p.memberCount} 张</span>
          </button>
        ))}
      </div>
    </div>
  );
}

"use client";

import { ScanProgressPanel } from "@/components/admin/scan-progress-panel";
import { StorageSourceStatusBadge } from "@/components/admin/storage-source-status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { UnifiedPhotosResponse } from "@relight/shared";

interface StorageSourceHeaderProps {
  storageSource: NonNullable<UnifiedPhotosResponse["storageSource"]>;
}

const typeLabels: Record<string, string> = {
  local: "本地",
  smb: "SMB",
  webdav: "WebDAV",
};

const blockedStatuses = ["inaccessible", "unmounted", "permission_denied"];

export function StorageSourceHeader({ storageSource }: StorageSourceHeaderProps) {
  const coverage =
    storageSource.photoCount > 0
      ? Math.round((storageSource.analyzedCount / storageSource.photoCount) * 100)
      : 0;

  const isDisabled = !!storageSource.status && blockedStatuses.includes(storageSource.status);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold">{storageSource.name}</h3>
              <Badge variant="secondary" className="text-xs">
                {typeLabels[storageSource.type] ?? storageSource.type}
              </Badge>
              <StorageSourceStatusBadge
                status={storageSource.status ?? "unknown"}
                lastError={storageSource.lastError}
              />
            </div>
            <p className="mt-1 text-sm text-muted-foreground font-mono text-xs">
              {storageSource.rootPath}
            </p>
          </div>
          <ScanProgressPanel storageSourceId={storageSource.id} disabled={isDisabled} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">照片总数</span>
            <p className="text-lg font-semibold">{storageSource.photoCount}</p>
          </div>
          <div>
            <span className="text-muted-foreground">已分析</span>
            <p className="text-lg font-semibold">{storageSource.analyzedCount}</p>
          </div>
          <div>
            <span className="text-muted-foreground">覆盖率</span>
            <p className="text-lg font-semibold">{coverage}%</p>
          </div>
          <div>
            <span className="text-muted-foreground">最后扫描</span>
            <p className="text-sm font-semibold">
              {storageSource.lastScanAt
                ? new Date(storageSource.lastScanAt).toLocaleString("zh-CN")
                : "从未"}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

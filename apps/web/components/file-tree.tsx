"use client";

import { cn } from "@/lib/utils";
import type { FileTreeNode } from "@relight/shared";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "./ui/badge";
import { Checkbox } from "./ui/checkbox";

interface FileTreeProps {
  tree: FileTreeNode[];
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  disabled?: boolean;
}

/** 收集节点下所有文件的 photoId */
function collectFileIds(node: FileTreeNode): string[] {
  if (node.type === "file") {
    return node.photoId ? [node.photoId] : [];
  }
  return (node.children ?? []).flatMap(collectFileIds);
}

export function FileTree({
  tree,
  selectedIds,
  onSelectionChange,
  disabled = false,
}: FileTreeProps) {
  return (
    <div className="rounded-lg border bg-card">
      {tree.map((node) => (
        <TreeNodeRenderer
          key={node.path}
          node={node}
          depth={0}
          selectedIds={selectedIds}
          onSelectionChange={onSelectionChange}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

interface TreeNodeRendererProps {
  node: FileTreeNode;
  depth: number;
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  disabled?: boolean;
  collapsedIds?: Set<string>;
  onToggleCollapse?: (path: string) => void;
}

function TreeNodeRenderer({
  node,
  depth,
  selectedIds,
  onSelectionChange,
  disabled = false,
  collapsedIds,
  onToggleCollapse,
}: TreeNodeRendererProps) {
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const collapsed = collapsedIds?.has(node.path) ?? localCollapsed;

  const toggleCollapse = useCallback(() => {
    if (onToggleCollapse) {
      onToggleCollapse(node.path);
    } else {
      setLocalCollapsed((prev) => !prev);
    }
  }, [node.path, onToggleCollapse]);

  if (node.type === "file") {
    return (
      <FileRow
        node={node}
        depth={depth}
        selectedIds={selectedIds}
        onSelectionChange={onSelectionChange}
        disabled={disabled}
      />
    );
  }

  // Folder node
  const allChildIds = useMemo(() => collectFileIds(node), [node]);
  const selectedChildIds = allChildIds.filter((id) => selectedIds.has(id));
  const allSelected = allChildIds.length > 0 && selectedChildIds.length === allChildIds.length;
  const someSelected = selectedChildIds.length > 0 && selectedChildIds.length < allChildIds.length;

  const handleFolderCheck = useCallback(() => {
    const next = new Set(selectedIds);
    if (allSelected) {
      for (const id of allChildIds) next.delete(id);
    } else {
      for (const id of allChildIds) next.add(id);
    }
    onSelectionChange(next);
  }, [allSelected, allChildIds, selectedIds, onSelectionChange]);

  // Children status counts
  const analyzedCount = useMemo(
    () =>
      allChildIds.filter((id) => {
        const child = findNodeById(node, id);
        return child?.analysisStatus === "analyzed";
      }).length,
    [node, allChildIds],
  );
  const pendingCount = allChildIds.length - analyzedCount;

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1 px-3 py-1.5 hover:bg-accent/50 border-b border-border/50 text-sm",
        )}
        style={{ paddingLeft: `${12 + depth * 20}px` }}
        role="treeitem"
        aria-expanded={!collapsed}
      >
        {/* 折叠按钮 */}
        <button
          type="button"
          onClick={toggleCollapse}
          className="mr-0.5 p-0.5 rounded hover:bg-accent"
          aria-label={collapsed ? "展开文件夹" : "折叠文件夹"}
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")}
          />
        </button>

        {/* Checkbox (indeterminate for partial selection) */}
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected}
          onChange={handleFolderCheck}
          disabled={disabled || allChildIds.length === 0}
          aria-label={`选择 ${node.name} 中所有文件`}
        />

        {/* 文件夹图标 */}
        {collapsed ? (
          <Folder className="size-4 text-muted-foreground shrink-0" />
        ) : (
          <FolderOpen className="size-4 text-muted-foreground shrink-0" />
        )}

        {/* 文件夹名称 */}
        <span className="font-medium truncate flex-1 min-w-0 ml-1">{node.name}</span>

        {/* 分析进度徽标 */}
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {analyzedCount}/{allChildIds.length}
        </span>
      </div>

      {/* Children */}
      {!collapsed &&
        (node.children ?? []).map((child) => (
          <TreeNodeRenderer
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedIds={selectedIds}
            onSelectionChange={onSelectionChange}
            disabled={disabled}
            collapsedIds={collapsedIds}
            onToggleCollapse={onToggleCollapse}
          />
        ))}
    </div>
  );
}

function FileRow({
  node,
  depth,
  selectedIds,
  onSelectionChange,
  disabled = false,
}: TreeNodeRendererProps) {
  const photoId = node.photoId;
  const isSelected = photoId ? selectedIds.has(photoId) : false;

  const handleCheck = useCallback(() => {
    if (!photoId) return;
    const next = new Set(selectedIds);
    if (isSelected) {
      next.delete(photoId);
    } else {
      next.add(photoId);
    }
    onSelectionChange(next);
  }, [photoId, isSelected, selectedIds, onSelectionChange]);

  return (
    <div
      className={cn(
        "flex items-center gap-1 px-3 py-1.5 hover:bg-accent/50 border-b border-border/30 text-sm",
      )}
      style={{ paddingLeft: `${12 + depth * 20}px` }}
      role="treeitem"
    >
      {/* Checkbox */}
      <div className="mr-4" />
      <Checkbox
        checked={isSelected}
        onChange={handleCheck}
        disabled={disabled || !photoId}
        aria-label={`选择 ${node.name}`}
      />

      {/* 文件图标 */}
      <File className="size-4 text-muted-foreground shrink-0" />

      {/* 文件名 */}
      <span className="truncate flex-1 min-w-0 ml-1">{node.name}</span>

      {/* 文件大小 */}
      {node.fileSize != null && (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {formatFileSize(node.fileSize)}
        </span>
      )}

      {/* 分析状态徽标 */}
      <StatusBadge status={node.analysisStatus} />
    </div>
  );
}

function StatusBadge({ status }: { status?: string }) {
  if (status === "analyzed") {
    return (
      <Badge variant="default" className="text-xs ml-1">
        已分析
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="default" className="text-xs ml-1 bg-destructive text-destructive-foreground">
        失败
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-xs ml-1">
      待分析
    </Badge>
  );
}

/** 递归查找节点 */
function findNodeById(node: FileTreeNode, photoId: string): FileTreeNode | null {
  if (node.type === "file" && node.photoId === photoId) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNodeById(child, photoId);
      if (found) return found;
    }
  }
  return null;
}

/** 格式化文件大小 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

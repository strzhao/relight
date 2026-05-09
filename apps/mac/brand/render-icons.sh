#!/usr/bin/env bash
# 渲染 apps/mac/brand/icon.svg 到 AppIcon.appiconset 的 10 个 PNG 尺寸。
# 依赖：librsvg（brew install librsvg）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/icon.svg"
OUT="$SCRIPT_DIR/../Relight/Assets.xcassets/AppIcon.appiconset"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "错误：rsvg-convert 未安装。请先运行：brew install librsvg" >&2
  exit 1
fi

if [[ ! -f "$SRC" ]]; then
  echo "错误：找不到 $SRC" >&2
  exit 1
fi

mkdir -p "$OUT"

render() {
  local size="$1" name="$2"
  rsvg-convert -w "$size" -h "$size" "$SRC" -o "$OUT/$name"
  echo "  ✓ $name (${size}px)"
}

echo "渲染 AppIcon → $OUT"
render 16   icon_16x16.png
render 32   icon_16x16@2x.png
render 32   icon_32x32.png
render 64   icon_32x32@2x.png
render 128  icon_128x128.png
render 256  icon_128x128@2x.png
render 256  icon_256x256.png
render 512  icon_256x256@2x.png
render 512  icon_512x512.png
render 1024 icon_512x512@2x.png

echo "完成。"

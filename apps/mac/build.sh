#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

ARCHIVE_PATH="./build/Relight.xcarchive"
DIST_PATH="./build/dist"

# 清理旧产物
rm -rf "$ARCHIVE_PATH" "$DIST_PATH"
mkdir -p "$DIST_PATH"

# 1. archive (Release 配置，ad-hoc 签名)
xcodebuild -project Relight.xcodeproj \
  -scheme Relight \
  -configuration Release \
  -archivePath "$ARCHIVE_PATH" \
  CODE_SIGN_IDENTITY=- \
  CODE_SIGNING_REQUIRED=NO \
  archive

# 2. 把 .app 从 .xcarchive 拷出来
cp -R "$ARCHIVE_PATH/Products/Applications/Relight.app" "$DIST_PATH/"

echo ""
echo "✅ 构建完成"
echo "   位置: $DIST_PATH/Relight.app"
echo "   首次运行：在「系统设置 → 隐私与安全」中允许"
echo "   启动: open $DIST_PATH/Relight.app"

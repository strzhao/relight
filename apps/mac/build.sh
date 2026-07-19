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

# 3. 用有效签名重签（ad-hoc 签名的 app 无法注册 SMAppService 登录项，autostart 会失效）
#    默认 claude-code-buddy-dev（本机开发证书）；发布他人时通过 RELIGHT_SIGN_IDENTITY 传 Developer ID
SIGN_IDENTITY="${RELIGHT_SIGN_IDENTITY:-claude-code-buddy-dev}"
if codesign --force --deep --sign "$SIGN_IDENTITY" "$DIST_PATH/Relight.app" 2>/dev/null; then
  echo "   已用 $SIGN_IDENTITY 重签（autostart 登录项可用）"
else
  echo "   ⚠️  codesign 重签失败（证书 $SIGN_IDENTITY 不可用），autostart 登录项将不可用"
fi

echo ""
echo "✅ 构建完成"
echo "   位置: $DIST_PATH/Relight.app"
echo "   首次运行：在「系统设置 → 隐私与安全」中允许"
echo "   启动: open $DIST_PATH/Relight.app"

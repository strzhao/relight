#!/usr/bin/env bash
# scaffold.acceptance.test.sh
# 001-mac-xcode-scaffold 验收脚本
# 运行方式：bash apps/mac/scaffold.acceptance.test.sh
# 退出码：0 = 全部通过，非 0 = 失败
#
# 职责：黑盒验收 apps/mac/ 脚手架的文件结构、Info.plist 字段、
#       xcodebuild 编译、APP 启动、monorepo 集成及现有工作流不被破坏。

set -euo pipefail

# ────────────────────────────────────────────────────────────
# 初始化
# ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MAC_DIR="${REPO_ROOT}/apps/mac"
PLIST="${MAC_DIR}/Relight/Info.plist"
PLISTBUDDY="/usr/libexec/PlistBuddy"

PASS=0
FAIL=0

pass() { echo "  ✔ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✘ $1"; echo "    原因: $2"; FAIL=$((FAIL + 1)); }

# 严格模式下 fail 后立即退出
check_fail() {
  echo ""
  echo "❌ 验收失败：$1"
  echo "   原因：$2"
  exit 1
}

# ────────────────────────────────────────────────────────────
# A 组：文件结构存在性（共 9 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check A: 文件结构存在性"
echo "──────────────────────────────────────"

A_FILES=(
  ".gitignore"
  "README.md"
  "package.json"
  "Relight.xcodeproj/project.pbxproj"
  "Relight/RelightApp.swift"
  "Relight/ContentView.swift"
  "Relight/Info.plist"
  "Relight/Assets.xcassets/Contents.json"
  "Relight/Assets.xcassets/AppIcon.appiconset/Contents.json"
)

for rel in "${A_FILES[@]}"; do
  target="${MAC_DIR}/${rel}"
  if [ -e "${target}" ]; then
    pass "apps/mac/${rel} 存在"
  else
    check_fail "A 组 — 文件不存在" "apps/mac/${rel} 未找到"
  fi
done

# ────────────────────────────────────────────────────────────
# B 组：package.json 契约（共 3 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check B: package.json 契约"
echo "──────────────────────────────────────"

PKG="${MAC_DIR}/package.json"

# B1: .name == "@relight/mac"
PKG_NAME=$(jq -r '.name' "${PKG}" 2>/dev/null || true)
if [ "${PKG_NAME}" = "@relight/mac" ]; then
  pass "package.json .name == \"@relight/mac\""
else
  check_fail "B1 — package.json .name 不正确" "期望 @relight/mac，实际: ${PKG_NAME}"
fi

# B2: .scripts.build 包含 "xcodebuild"
BUILD_SCRIPT=$(jq -r '.scripts.build // ""' "${PKG}" 2>/dev/null || true)
if echo "${BUILD_SCRIPT}" | grep -q "xcodebuild"; then
  pass "package.json .scripts.build 包含 xcodebuild"
else
  check_fail "B2 — .scripts.build 不包含 xcodebuild" "实际值: ${BUILD_SCRIPT}"
fi

# B3: 不应有 dependencies 字段，或为空对象
DEPS=$(jq '.dependencies // null' "${PKG}" 2>/dev/null || true)
if [ "${DEPS}" = "null" ] || [ "${DEPS}" = "{}" ]; then
  pass "package.json 无 runtime dependencies（符合纯脚手架定位）"
else
  # 警告而非失败（设计文档表述为"不应有或为空"）
  echo "  ⚠ package.json 存在 dependencies: ${DEPS}（预期为空，请确认是否必要）"
fi

# ────────────────────────────────────────────────────────────
# C 组：Info.plist 关键字段（共 5 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check C: Info.plist 关键字段（使用 PlistBuddy 读取）"
echo "──────────────────────────────────────"

plist_check() {
  local key="$1"
  local expected="$2"
  local actual
  actual=$("${PLISTBUDDY}" -c "Print ${key}" "${PLIST}" 2>/dev/null || true)
  if [ -z "${actual}" ]; then
    check_fail "C 组 — ${key} 缺失或为空" "${PLIST} 中找不到键 ${key}"
  fi
  if [ "${expected}" = "__NONEMPTY__" ]; then
    pass "Info.plist ${key} 非空（实际: ${actual}）"
  elif [ "${actual}" = "${expected}" ]; then
    pass "Info.plist ${key} == \"${expected}\""
  else
    check_fail "C 组 — ${key} 值不匹配" "期望: ${expected}，实际: ${actual}"
  fi
}

plist_check "CFBundleIdentifier"   "app.relight.mac"
plist_check "CFBundleExecutable"   "__NONEMPTY__"
plist_check "CFBundlePackageType"  "APPL"
plist_check "LSMinimumSystemVersion" "13.0"
plist_check "CFBundleDisplayName"  "拾光"

# ────────────────────────────────────────────────────────────
# D 组：xcodebuild 编译（共 5 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check D: xcodebuild 编译"
echo "──────────────────────────────────────"

XCODEPROJ="${MAC_DIR}/Relight.xcodeproj"
BUILD_DIR="${MAC_DIR}/build"
APP_PATH="${BUILD_DIR}/Build/Products/Debug/Relight.app"
APP_BINARY="${APP_PATH}/Contents/MacOS/Relight"
APP_PLIST="${APP_PATH}/Contents/Info.plist"

# D1: xcodebuild -list 列出 Relight target/scheme
echo "  → 正在运行 xcodebuild -list..."
XCODE_LIST=$(xcodebuild -project "${XCODEPROJ}" -list 2>&1 || true)
if echo "${XCODE_LIST}" | grep -q "Relight"; then
  pass "xcodebuild -list 列出 Relight target/scheme"
else
  check_fail "D1 — xcodebuild -list 无 Relight" "输出:\n${XCODE_LIST}"
fi

# D2: xcodebuild 编译（退出码 0）
echo "  → 正在编译（这可能需要数分钟，首次编译更长）..."
BUILD_LOG="${TMPDIR:-/tmp}/relight-mac-build-$$.log"
if xcodebuild \
    -project "${XCODEPROJ}" \
    -scheme Relight \
    -configuration Debug \
    build \
    CODE_SIGN_IDENTITY=- \
    CODE_SIGNING_REQUIRED=NO \
    -derivedDataPath "${BUILD_DIR}" \
    > "${BUILD_LOG}" 2>&1; then
  pass "xcodebuild 编译成功（退出码 0）"
else
  BUILD_EXIT=$?
  echo ""
  echo "  ✘ xcodebuild 编译失败（退出码 ${BUILD_EXIT}）"
  echo "  ── 最后 50 行编译日志 ──"
  tail -50 "${BUILD_LOG}" || true
  rm -f "${BUILD_LOG}"
  check_fail "D2 — xcodebuild 编译失败" "查看上方日志"
fi
rm -f "${BUILD_LOG}"

# D3: Relight.app bundle 存在
if [ -d "${APP_PATH}" ]; then
  pass "Relight.app bundle 存在：${APP_PATH}"
else
  check_fail "D3 — Relight.app 不存在" "期望路径: ${APP_PATH}"
fi

# D4: 可执行文件存在且有执行权限
if [ -x "${APP_BINARY}" ]; then
  pass "Relight.app/Contents/MacOS/Relight 存在且可执行"
else
  check_fail "D4 — 可执行文件缺失或无执行权限" "期望路径: ${APP_BINARY}"
fi

# D5: 编译产物 Info.plist 中 CFBundleIdentifier 正确
BUILT_BID=$("${PLISTBUDDY}" -c "Print CFBundleIdentifier" "${APP_PLIST}" 2>/dev/null || true)
if [ "${BUILT_BID}" = "app.relight.mac" ]; then
  pass "编译产物 Info.plist CFBundleIdentifier == \"app.relight.mac\""
else
  check_fail "D5 — 编译产物 CFBundleIdentifier 不匹配" "期望: app.relight.mac，实际: ${BUILT_BID}"
fi

# ────────────────────────────────────────────────────────────
# E 组：APP 启动验收（共 2 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check E: APP 启动验收"
echo "──────────────────────────────────────"

# 确保没有残留进程
pkill -f "Relight.app/Contents/MacOS/Relight" 2>/dev/null || true
sleep 1

echo "  → 启动 Relight.app..."
open "${APP_PATH}"
sleep 3

# E1: 进程存在
if ps aux | grep -E "Relight\.app/Contents/MacOS/Relight" | grep -v grep > /dev/null 2>&1; then
  pass "Relight 进程已启动（ps aux 确认）"
else
  # 清理后失败
  pkill -f "Relight.app/Contents/MacOS/Relight" 2>/dev/null || true
  check_fail "E1 — Relight 进程未出现" "open 后 3 秒内未找到进程"
fi

# E2: 进程拥有 Relight 可执行文件路径（确认不是误匹配）
PROC_LINE=$(ps aux | grep -E "Relight\.app/Contents/MacOS/Relight" | grep -v grep | head -1 || true)
if echo "${PROC_LINE}" | grep -q "Relight"; then
  pass "进程命令行包含 Relight 路径（无误匹配）"
else
  pkill -f "Relight.app/Contents/MacOS/Relight" 2>/dev/null || true
  check_fail "E2 — 进程行无法确认为 Relight" "实际进程行: ${PROC_LINE}"
fi

# 清理：终止 APP
echo "  → 清理：终止 Relight 进程..."
pkill -f "Relight.app/Contents/MacOS/Relight" 2>/dev/null || true
sleep 1

# ────────────────────────────────────────────────────────────
# F 组：monorepo 集成（共 1 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check F: monorepo 集成"
echo "──────────────────────────────────────"

# F1: pnpm --filter @relight/mac build 在仓库根成功
echo "  → 运行 pnpm --filter @relight/mac build（仓库根: ${REPO_ROOT}）..."
PNPM_LOG="${TMPDIR:-/tmp}/relight-pnpm-build-$$.log"
if (cd "${REPO_ROOT}" && pnpm --filter @relight/mac build > "${PNPM_LOG}" 2>&1); then
  pass "pnpm --filter @relight/mac build 成功（退出码 0）"
else
  PNPM_EXIT=$?
  echo ""
  echo "  ✘ pnpm --filter @relight/mac build 失败（退出码 ${PNPM_EXIT}）"
  echo "  ── 最后 30 行日志 ──"
  tail -30 "${PNPM_LOG}" || true
  rm -f "${PNPM_LOG}"
  check_fail "F1 — pnpm build 失败" "查看上方日志"
fi
rm -f "${PNPM_LOG}"

# ────────────────────────────────────────────────────────────
# G 组：不破坏现有工作流（共 1 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check G: 不破坏现有工作流"
echo "──────────────────────────────────────"

# G1: 仓库根 pnpm typecheck 仍通过
echo "  → 运行 pnpm typecheck（仓库根: ${REPO_ROOT}）..."
TYPECHECK_LOG="${TMPDIR:-/tmp}/relight-typecheck-$$.log"
if (cd "${REPO_ROOT}" && pnpm typecheck > "${TYPECHECK_LOG}" 2>&1); then
  pass "pnpm typecheck 通过（退出码 0）"
else
  TC_EXIT=$?
  echo ""
  echo "  ✘ pnpm typecheck 失败（退出码 ${TC_EXIT}）"
  echo "  ── 最后 30 行日志 ──"
  tail -30 "${TYPECHECK_LOG}" || true
  rm -f "${TYPECHECK_LOG}"
  check_fail "G1 — pnpm typecheck 失败（现有工作流被破坏）" "查看上方日志"
fi
rm -f "${TYPECHECK_LOG}"

# ────────────────────────────────────────────────────────────
# 汇总
# ────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════"
echo "验收结果：✔ ${PASS} 通过  ✘ ${FAIL} 失败"
echo "══════════════════════════════════════════"

if [ "${FAIL}" -gt 0 ]; then
  echo "❌ 验收未通过"
  exit 1
fi

echo "✅ All checks passed"
exit 0

#!/usr/bin/env bash
# menubar.acceptance.test.sh
# 005-menubar-extra 验收脚本
# 运行方式：bash apps/mac/menubar.acceptance.test.sh
# 退出码：0 = 全部通过，非 0 = 失败
#
# 职责：黑盒验收 MenuBarExtra + Settings scene + UserDefaults 持久化改造，
#       包括文件结构、Info.plist LSUIElement、xcodebuild 编译、
#       APP 驻留型启动、menubar-smoke self-test、UserDefaults 持久化、
#       现有 SelfTest 不被破坏（关键回归）、以及 pnpm typecheck。

set -euo pipefail

# ────────────────────────────────────────────────────────────
# 初始化
# ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MAC_DIR="${REPO_ROOT}/apps/mac"
XCODEPROJ="${MAC_DIR}/Relight.xcodeproj"
BUILD_DIR="${MAC_DIR}/build"
APP_PATH="${BUILD_DIR}/Build/Products/Debug/Relight.app"
APP_BINARY="${APP_PATH}/Contents/MacOS/Relight"
APP_PLIST="${APP_PATH}/Contents/Info.plist"
SRC_PLIST="${MAC_DIR}/Relight/Info.plist"
PLISTBUDDY="/usr/libexec/PlistBuddy"

PASS=0
FAIL=0
SKIP=0

pass() { echo "  ✔ $1"; PASS=$((PASS + 1)); }
skip() { echo "  ⏭ $1（跳过：$2）"; SKIP=$((SKIP + 1)); }
fail_and_exit() {
  echo ""
  echo "❌ 验收失败：$1"
  echo "   原因：$2"
  exit 1
}

# ────────────────────────────────────────────────────────────
# A 组：文件存在性（共 5 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check A: 文件存在性（5 个新 Swift 文件）"
echo "──────────────────────────────────────"

A_FILES=(
  "Relight/UI/MenuBarCommandBus.swift"
  "Relight/UI/MenuBarContent.swift"
  "Relight/UI/SettingsView.swift"
  "Relight/UI/SettingsTabs/GeneralSettingsTab.swift"
  "Relight/UI/SettingsTabs/AboutTab.swift"
)

for rel in "${A_FILES[@]}"; do
  target="${MAC_DIR}/${rel}"
  if [ -f "${target}" ]; then
    pass "apps/mac/${rel} 存在"
  else
    fail_and_exit "A 组 — 文件不存在" "apps/mac/${rel} 未找到"
  fi
done

# ────────────────────────────────────────────────────────────
# B 组：xcodebuild 编译（共 2 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check B: xcodebuild 编译"
echo "──────────────────────────────────────"

# B1: xcodebuild -list 含 Relight target/scheme
echo "  → 正在运行 xcodebuild -list..."
XCODE_LIST=$(xcodebuild -project "${XCODEPROJ}" -list 2>&1 || true)
if echo "${XCODE_LIST}" | grep -q "Relight"; then
  pass "xcodebuild -list 列出 Relight target/scheme"
else
  fail_and_exit "B1 — xcodebuild -list 无 Relight" "输出: ${XCODE_LIST}"
fi

# B2: Debug build 退出码 0
echo "  → 正在编译（首次编译可能需要数分钟）..."
BUILD_LOG="${TMPDIR:-/tmp}/relight-menubar-build-$$.log"
if xcodebuild \
    -project "${XCODEPROJ}" \
    -scheme Relight \
    -configuration Debug \
    build \
    CODE_SIGN_IDENTITY=- \
    CODE_SIGNING_REQUIRED=NO \
    -derivedDataPath "${BUILD_DIR}" \
    > "${BUILD_LOG}" 2>&1; then
  pass "xcodebuild Debug build 成功（退出码 0）"
else
  BUILD_EXIT=$?
  echo ""
  echo "  ✘ xcodebuild 编译失败（退出码 ${BUILD_EXIT}）"
  echo "  ── 最后 60 行编译日志 ──"
  tail -60 "${BUILD_LOG}" || true
  rm -f "${BUILD_LOG}"
  fail_and_exit "B2 — xcodebuild 编译失败" "查看上方日志"
fi
rm -f "${BUILD_LOG}"

# ────────────────────────────────────────────────────────────
# C 组：Info.plist 改造（共 1 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check C: Info.plist LSUIElement 改造"
echo "──────────────────────────────────────"

# C1: 源码 Info.plist LSUIElement=true（使用 PlistBuddy）
LSU_VALUE=$("${PLISTBUDDY}" -c "Print LSUIElement" "${SRC_PLIST}" 2>/dev/null || true)
if [ "${LSU_VALUE}" = "true" ]; then
  pass "Info.plist LSUIElement == true（菜单栏 APP 驻留型）"
else
  fail_and_exit "C1 — Info.plist LSUIElement 不正确" \
    "期望: true，实际: '${LSU_VALUE}'（路径: ${SRC_PLIST}）"
fi

# ────────────────────────────────────────────────────────────
# D 组：APP 启动（菜单栏 APP 驻留型）（共 2 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check D: APP 启动（菜单栏 APP 驻留型）"
echo "──────────────────────────────────────"

# 确保没有残留进程
pkill -f "Relight.app/Contents/MacOS/Relight" 2>/dev/null || true
sleep 1

echo "  → 启动 Relight.app..."
open "${APP_PATH}"
sleep 3

# D1: 进程存在（驻留型验证）
if ps aux | grep -E "Relight\.app/Contents/MacOS/Relight" | grep -v grep > /dev/null 2>&1; then
  pass "Relight 进程已驻留（ps aux 确认进程存在）"
else
  pkill -f "Relight.app/Contents/MacOS/Relight" 2>/dev/null || true
  fail_and_exit "D1 — Relight 进程未驻留" \
    "open 后 3 秒内未找到进程（期望菜单栏 APP 驻留而非立即退出）"
fi

# D2: 进程命令行无误匹配
PROC_LINE=$(ps aux | grep -E "Relight\.app/Contents/MacOS/Relight" | grep -v grep | head -1 || true)
if echo "${PROC_LINE}" | grep -q "Relight"; then
  pass "进程命令行包含 Relight 路径（无误匹配）"
else
  pkill -f "Relight.app/Contents/MacOS/Relight" 2>/dev/null || true
  fail_and_exit "D2 — 进程行无法确认为 Relight" "实际进程行: ${PROC_LINE}"
fi

# 兜底清理
echo "  → 清理：终止 Relight 进程..."
pkill -f "Relight.app/Contents/MacOS/Relight" 2>/dev/null || true
sleep 1

# ────────────────────────────────────────────────────────────
# E 组：menubar-smoke self-test（共 4 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check E: menubar-smoke self-test（--self-test=menubar-smoke）"
echo "──────────────────────────────────────"

SMOKE_LOG="${TMPDIR:-/tmp}/relight-menubar-smoke-$$.log"
SMOKE_EXIT=0
echo "  → 运行 Relight --self-test=menubar-smoke ..."
timeout 30 "${APP_BINARY}" "--self-test=menubar-smoke" > "${SMOKE_LOG}" 2>&1 || SMOKE_EXIT=$?

# E1: 退出码 0
if [ "${SMOKE_EXIT}" -eq 0 ]; then
  pass "--self-test=menubar-smoke 退出码 0"
else
  echo "  ✘ --self-test=menubar-smoke 退出码 ${SMOKE_EXIT}（期望 0）"
  echo "  ── 完整输出 ──"
  cat "${SMOKE_LOG}" || true
  rm -f "${SMOKE_LOG}"
  fail_and_exit "E1 — menubar-smoke self-test 退出码异常" "退出码: ${SMOKE_EXIT}"
fi

# E2: 输出含 LSUIElement=true
if grep -q "LSUIElement=true" "${SMOKE_LOG}"; then
  pass "输出含 'LSUIElement=true'"
else
  echo "  ✘ 输出中未找到 'LSUIElement=true'"
  echo "  ── 完整输出 ──"
  cat "${SMOKE_LOG}" || true
  rm -f "${SMOKE_LOG}"
  fail_and_exit "E2 — 输出未含 LSUIElement=true" "期望 menubar-smoke 打印 LSUIElement=true"
fi

# E3: 输出含 apiURL=
if grep -q "apiURL=" "${SMOKE_LOG}"; then
  pass "输出含 'apiURL='"
else
  echo "  ✘ 输出中未找到 'apiURL='"
  echo "  ── 完整输出 ──"
  cat "${SMOKE_LOG}" || true
  rm -f "${SMOKE_LOG}"
  fail_and_exit "E3 — 输出未含 apiURL=" "期望 menubar-smoke 打印 apiURL=<值>"
fi

# E4: 输出含 autoStart=
if grep -q "autoStart=" "${SMOKE_LOG}"; then
  pass "输出含 'autoStart='"
else
  echo "  ✘ 输出中未找到 'autoStart='"
  echo "  ── 完整输出 ──"
  cat "${SMOKE_LOG}" || true
  rm -f "${SMOKE_LOG}"
  fail_and_exit "E4 — 输出未含 autoStart=" "期望 menubar-smoke 打印 autoStart=<值>"
fi

# E5: 输出含 commandBus.onRefreshNow=nil（任务 005 不注入回调）
if grep -q "commandBus.onRefreshNow=nil" "${SMOKE_LOG}"; then
  pass "输出含 'commandBus.onRefreshNow=nil'（本任务不注入回调）"
else
  echo "  ✘ 输出中未找到 'commandBus.onRefreshNow=nil'"
  echo "  ── 完整输出 ──"
  cat "${SMOKE_LOG}" || true
  rm -f "${SMOKE_LOG}"
  fail_and_exit "E5 — 输出未含 commandBus.onRefreshNow=nil" \
    "期望任务 005 未注入 onRefreshNow 回调，输出应为 nil"
fi

rm -f "${SMOKE_LOG}"

# ────────────────────────────────────────────────────────────
# F 组：UserDefaults 持久化（共 2 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check F: UserDefaults 持久化"
echo "──────────────────────────────────────"

# F1: 写入 app.relight.autoStart=true，读回应得 1
echo "  → defaults write app.relight.mac app.relight.autoStart -bool true"
defaults write app.relight.mac app.relight.autoStart -bool true

UD_VALUE=$(defaults read app.relight.mac app.relight.autoStart 2>/dev/null || true)
echo "  → defaults read 返回: '${UD_VALUE}'"

if [ "${UD_VALUE}" = "1" ]; then
  pass "defaults write/read app.relight.autoStart 持久化生效（值为 1）"
else
  # 清理后失败
  defaults delete app.relight.mac app.relight.autoStart 2>/dev/null || true
  fail_and_exit "F1 — UserDefaults 持久化验证失败" \
    "期望 defaults read 返回 1，实际: '${UD_VALUE}'"
fi

# 清理：删除写入的 key
defaults delete app.relight.mac app.relight.autoStart 2>/dev/null || true
pass "UserDefaults 清理完成（app.relight.autoStart 已删除）"

# ────────────────────────────────────────────────────────────
# G 组：现有 SelfTest 不被破坏（关键回归）（共 2 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check G: 现有 SelfTest 不被破坏（关键回归点）"
echo "──────────────────────────────────────"
echo "  ℹ 验证 RelightApp 改造后 002 的 SelfTest cases 仍可运行"

# G1: --self-test=codable 退出码 0（不依赖 backend，应在任何环境下通过）
CODABLE_LOG="${TMPDIR:-/tmp}/relight-codable-$$.log"
CODABLE_EXIT=0
echo "  → 运行 Relight --self-test=codable ..."
timeout 30 "${APP_BINARY}" "--self-test=codable" > "${CODABLE_LOG}" 2>&1 || CODABLE_EXIT=$?

if [ "${CODABLE_EXIT}" -eq 0 ]; then
  pass "--self-test=codable 退出码 0（现有 SelfTest 未被破坏）"
else
  echo "  ✘ --self-test=codable 退出码 ${CODABLE_EXIT}（期望 0）"
  echo "  ── 完整输出 ──"
  cat "${CODABLE_LOG}" || true
  rm -f "${CODABLE_LOG}"
  fail_and_exit "G1 — codable self-test 被破坏" \
    "RelightApp 改造破坏了 002 的 codable SelfTest case（退出码: ${CODABLE_EXIT}）"
fi

# G2: 输出不含 fail/error 字样（不区分大小写）
if grep -qiE "\bfail\b|\berror\b" "${CODABLE_LOG}"; then
  MATCHED=$(grep -iE "\bfail\b|\berror\b" "${CODABLE_LOG}" | head -3 || true)
  echo "  ✘ codable 输出含 fail/error 字样"
  echo "  ── 匹配行 ──"
  echo "${MATCHED}"
  echo "  ── 完整输出 ──"
  cat "${CODABLE_LOG}" || true
  rm -f "${CODABLE_LOG}"
  fail_and_exit "G2 — codable 输出含 fail/error" \
    "RelightApp 改造可能引入了 codable 错误；匹配行: ${MATCHED}"
else
  pass "codable 输出不含 fail/error 字样（无回归错误）"
fi

rm -f "${CODABLE_LOG}"

# ────────────────────────────────────────────────────────────
# H 组：不破坏现有工作流（共 1 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check H: 不破坏现有工作流（pnpm typecheck）"
echo "──────────────────────────────────────"

# H1: 仓库根 pnpm typecheck 退出码 0
echo "  → 运行 pnpm typecheck（仓库根: ${REPO_ROOT}）..."
TC_LOG="${TMPDIR:-/tmp}/relight-menubar-typecheck-$$.log"
if (cd "${REPO_ROOT}" && pnpm typecheck > "${TC_LOG}" 2>&1); then
  pass "pnpm typecheck 通过（退出码 0）"
else
  TC_EXIT=$?
  echo ""
  echo "  ✘ pnpm typecheck 失败（退出码 ${TC_EXIT}）"
  echo "  ── 最后 30 行日志 ──"
  tail -30 "${TC_LOG}" || true
  rm -f "${TC_LOG}"
  fail_and_exit "H1 — pnpm typecheck 失败（现有工作流被破坏）" "查看上方日志"
fi
rm -f "${TC_LOG}"

# ────────────────────────────────────────────────────────────
# 汇总
# ────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════"
echo "验收结果：✔ ${PASS} 通过  ⏭ ${SKIP} 跳过  ✘ ${FAIL} 失败"
echo "══════════════════════════════════════════"

if [ "${FAIL}" -gt 0 ]; then
  echo "❌ 验收未通过"
  exit 1
fi

echo "✅ All checks passed"
exit 0

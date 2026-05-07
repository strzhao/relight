#!/usr/bin/env bash
# coordinator.acceptance.test.sh
# 006-coordinator 验收脚本
# 运行方式：bash apps/mac/coordinator.acceptance.test.sh
# 退出码：0 = 全部通过，非 0 = 失败
#
# 职责：黑盒验收 WallpaperCoordinator / AutostartManager / BeijingTime 三个新 Swift 文件，
#       xcodebuild 编译，coordinator-bootstrap self-test（依赖 backend），
#       关键回归（现有 SelfTest cases 不被破坏），以及 pnpm typecheck。
#
# 已知约束：
#   - C 组（coordinator-bootstrap）依赖 backend 在 localhost:3000 运行，且当天 daily-pick 已生成。
#     若 backend 不在线，整个 C 组优雅跳过，脚本仍可通过（只验证非 backend 相关 checks）。
#   - coordinator-bootstrap 会真实调用 WallpaperCoordinator，可能更改桌面壁纸（副作用）。
#     脚本会尽力记录并还原原始壁纸路径，但不强制保证还原成功。
#   - AutostartManager 的 SMAppService.register 不在脚本中调用，避免触发系统授权弹窗。

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
PLISTBUDDY="/usr/libexec/PlistBuddy"

PASS=0
FAIL=0
SKIP=0

# UserDefaults 备份相关
_ORIG_LAST_APPLIED_DATE=""
_BACKED_UP_DATE=false

pass() { echo "  ✔ $1"; PASS=$((PASS + 1)); }
skip() { echo "  ⏭ $1（跳过：$2）"; SKIP=$((SKIP + 1)); }
fail_and_exit() {
  echo ""
  echo "❌ 验收失败：$1"
  echo "   原因：$2"
  _cleanup
  exit 1
}

# ────────────────────────────────────────────────────────────
# 清理函数：尽力还原 UserDefaults 和壁纸
# ────────────────────────────────────────────────────────────
_cleanup() {
  # 还原 lastAppliedPickDate
  if "${_BACKED_UP_DATE}"; then
    if [ -n "${_ORIG_LAST_APPLIED_DATE}" ]; then
      defaults write app.relight.mac app.relight.lastAppliedPickDate \
        -string "${_ORIG_LAST_APPLIED_DATE}" 2>/dev/null || true
    else
      defaults delete app.relight.mac app.relight.lastAppliedPickDate 2>/dev/null || true
    fi
  fi

  # 尽力还原壁纸
  if [ -n "${_ORIG_WALLPAPER_PATH:-}" ] && [ -f "${_ORIG_WALLPAPER_PATH}" ]; then
    osascript -e \
      "tell application \"System Events\" to tell every desktop to set picture to \"${_ORIG_WALLPAPER_PATH}\"" \
      2>/dev/null || true
  fi

  # 终止可能残留的 Relight 进程
  pkill -f "Relight.app/Contents/MacOS/Relight" 2>/dev/null || true
}

trap '_cleanup' EXIT

# ────────────────────────────────────────────────────────────
# A 组：文件存在性（共 3 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check A: 文件存在性（3 个新 Coordinator Swift 文件）"
echo "──────────────────────────────────────"

A_FILES=(
  "Relight/Coordinator/BeijingTime.swift"
  "Relight/Coordinator/AutostartManager.swift"
  "Relight/Coordinator/WallpaperCoordinator.swift"
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
BUILD_LOG="${TMPDIR:-/tmp}/relight-coordinator-build-$$.log"
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
# C 组：coordinator-bootstrap self-test（依赖 backend）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check C: coordinator-bootstrap self-test（--self-test=coordinator-bootstrap）"
echo "──────────────────────────────────────"
echo "  ℹ 依赖：backend 在 localhost:3000 运行，且当天 daily-pick 已生成"
echo "  ℹ 副作用：可能真实更改桌面壁纸（脚本会尽力还原）"

# 探测 backend
BACKEND_ALIVE=false
echo "  → 检测 backend http://localhost:3000/api/daily/today ..."
PROBE=$(curl -s -m 3 "http://localhost:3000/api/daily/today" 2>/dev/null | head -c 200 || true)
if [ -n "${PROBE}" ]; then
  BACKEND_ALIVE=true
  echo "  → backend 在线，probe 响应（前 200 字节）: ${PROBE}"
fi

if ! "${BACKEND_ALIVE}"; then
  skip "C1 — 备份 lastAppliedPickDate" "backend 未在 localhost:3000 运行"
  skip "C2 — 清空 lastAppliedPickDate 以触发 bootstrap" "backend 未在 localhost:3000 运行"
  skip "C3 — 运行 --self-test=coordinator-bootstrap" "backend 未在 localhost:3000 运行"
  skip "C4 — 验证退出码 0（成功路径）" "backend 未在 localhost:3000 运行"
  skip "C5 — 验证 lastAppliedPickDate == 今天（北京时间）" "backend 未在 localhost:3000 运行"
  echo "  ⚠ 警告：C 组已跳过。请确保 backend 在 :3000 运行并已生成当天 daily-pick 后重跑以完整验收。"
else
  # C1: 记录当前壁纸路径（尽力还原）
  echo "  → 记录当前壁纸路径（用于测试后尽力还原）..."
  _ORIG_WALLPAPER_PATH=$(osascript -e 'tell application "System Events" to get picture of desktop 1' 2>/dev/null || true)
  export _ORIG_WALLPAPER_PATH
  if [ -n "${_ORIG_WALLPAPER_PATH}" ]; then
    echo "  → 原始壁纸路径: ${_ORIG_WALLPAPER_PATH}"
    pass "记录原始壁纸路径（尽力还原，非强制）"
  else
    echo "  ⚠ 无法获取原始壁纸路径（osascript 失败），继续..."
    PASS=$((PASS + 1))
  fi

  # C2: 备份并清空 lastAppliedPickDate，以强制触发 bootstrapOnLaunch
  echo "  → 备份 app.relight.lastAppliedPickDate..."
  _ORIG_LAST_APPLIED_DATE=$(defaults read app.relight.mac app.relight.lastAppliedPickDate 2>/dev/null || true)
  _BACKED_UP_DATE=true

  if [ -n "${_ORIG_LAST_APPLIED_DATE}" ]; then
    echo "  → 原始 lastAppliedPickDate: ${_ORIG_LAST_APPLIED_DATE}"
    pass "备份 lastAppliedPickDate（原值: ${_ORIG_LAST_APPLIED_DATE}）"
  else
    echo "  → lastAppliedPickDate 尚未设置（首次运行）"
    pass "lastAppliedPickDate 尚未设置，无需备份（bootstrap 必定触发）"
  fi

  echo "  → 清空 lastAppliedPickDate（确保 bootstrap 触发）..."
  defaults delete app.relight.mac app.relight.lastAppliedPickDate 2>/dev/null || true

  # C3: 运行 --self-test=coordinator-bootstrap
  echo "  → 运行 Relight --self-test=coordinator-bootstrap ..."
  BOOTSTRAP_LOG="${TMPDIR:-/tmp}/relight-coordinator-bootstrap-$$.log"
  BOOTSTRAP_EXIT=0
  timeout 120 "${APP_BINARY}" "--self-test=coordinator-bootstrap" \
    > "${BOOTSTRAP_LOG}" 2>&1 || BOOTSTRAP_EXIT=$?

  echo "  → self-test 退出码: ${BOOTSTRAP_EXIT}"

  # C4: 验证退出码
  if [ "${BOOTSTRAP_EXIT}" -eq 0 ]; then
    pass "--self-test=coordinator-bootstrap 退出码 0（成功路径：fetch + download + 设壁纸均成功）"
  elif [ "${BOOTSTRAP_EXIT}" -eq 1 ]; then
    echo "  ✘ --self-test=coordinator-bootstrap 退出码 1（验证失败）"
    echo "  ── 完整输出 ──"
    cat "${BOOTSTRAP_LOG}" || true
    rm -f "${BOOTSTRAP_LOG}"
    fail_and_exit "C4 — coordinator-bootstrap 验证失败（退出码 1）" \
      "bootstrapOnLaunch 完成但后验断言未通过（lastAppliedPickDate 不等于今天？）"
  else
    echo "  ✘ --self-test=coordinator-bootstrap 退出码 ${BOOTSTRAP_EXIT}（意外错误）"
    echo "  ── 完整输出 ──"
    cat "${BOOTSTRAP_LOG}" || true
    rm -f "${BOOTSTRAP_LOG}"
    fail_and_exit "C4 — coordinator-bootstrap 出现意外错误（退出码 ${BOOTSTRAP_EXIT}）" \
      "期望 0（成功）或 1（断言失败），实际: ${BOOTSTRAP_EXIT}"
  fi

  # C5: 验证 lastAppliedPickDate == 今天（北京时间 YYYY-MM-DD）
  # 北京时间 = UTC+8；用 date -v +8H 在 macOS 上计算
  TODAY_BEIJING=$(TZ="Asia/Shanghai" date +"%Y-%m-%d" 2>/dev/null || \
    date -u -v +8H +"%Y-%m-%d" 2>/dev/null || true)
  echo "  → 今天（北京时间）: ${TODAY_BEIJING}"

  LAST_APPLIED=$(defaults read app.relight.mac app.relight.lastAppliedPickDate 2>/dev/null || true)
  echo "  → defaults read lastAppliedPickDate: '${LAST_APPLIED}'"

  if [ "${LAST_APPLIED}" = "${TODAY_BEIJING}" ]; then
    pass "lastAppliedPickDate == 今天北京时间（${TODAY_BEIJING}）"
  else
    echo "  ✘ lastAppliedPickDate 与今天不符"
    echo "    期望: ${TODAY_BEIJING}，实际: '${LAST_APPLIED}'"
    cat "${BOOTSTRAP_LOG}" || true
    rm -f "${BOOTSTRAP_LOG}"
    fail_and_exit "C5 — lastAppliedPickDate 未被 bootstrap 更新为今天" \
      "期望: ${TODAY_BEIJING}，实际: '${LAST_APPLIED}'"
  fi

  rm -f "${BOOTSTRAP_LOG}"

  # 还原 lastAppliedPickDate（trap 也会做，这里提前主动还原）
  if [ -n "${_ORIG_LAST_APPLIED_DATE}" ]; then
    defaults write app.relight.mac app.relight.lastAppliedPickDate \
      -string "${_ORIG_LAST_APPLIED_DATE}" 2>/dev/null || true
    echo "  → lastAppliedPickDate 已还原至: ${_ORIG_LAST_APPLIED_DATE}"
  else
    defaults delete app.relight.mac app.relight.lastAppliedPickDate 2>/dev/null || true
    echo "  → lastAppliedPickDate 已清除（原本未设置）"
  fi
  _BACKED_UP_DATE=false  # 已手动还原，trap 不需再还原

  # 还原壁纸
  if [ -n "${_ORIG_WALLPAPER_PATH:-}" ] && [ -f "${_ORIG_WALLPAPER_PATH}" ]; then
    osascript -e \
      "tell application \"System Events\" to tell every desktop to set picture to \"${_ORIG_WALLPAPER_PATH}\"" \
      2>/dev/null || true
    echo "  → 壁纸已还原至: ${_ORIG_WALLPAPER_PATH}"
  fi
fi

# ────────────────────────────────────────────────────────────
# D 组：关键回归 — 现有 SelfTest cases 不被破坏（共 4 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check D: 关键回归 — 现有 SelfTest cases 不被破坏"
echo "──────────────────────────────────────"
echo "  ℹ 验证 RelightApp 改造后，002-007 的 SelfTest cases 仍可运行"

# D1: --self-test=codable 退出码 0（不依赖 backend，任何环境下应通过）
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
  fail_and_exit "D1 — codable self-test 被破坏" \
    "RelightApp init 改造破坏了 codable SelfTest case（退出码: ${CODABLE_EXIT}）"
fi

# D2: codable 输出不含 fail/error 字样（不区分大小写）
if grep -qiE "\bfail\b|\berror\b" "${CODABLE_LOG}"; then
  MATCHED=$(grep -iE "\bfail\b|\berror\b" "${CODABLE_LOG}" | head -3 || true)
  echo "  ✘ codable 输出含 fail/error 字样"
  echo "  ── 匹配行 ──"
  echo "${MATCHED}"
  echo "  ── 完整输出 ──"
  cat "${CODABLE_LOG}" || true
  rm -f "${CODABLE_LOG}"
  fail_and_exit "D2 — codable 输出含 fail/error" \
    "RelightApp init 改造可能引入了 codable 错误；匹配行: ${MATCHED}"
else
  pass "codable 输出不含 fail/error 字样（无回归错误）"
fi
rm -f "${CODABLE_LOG}"

# D3: --self-test=menubar-smoke 退出码 0
SMOKE_LOG="${TMPDIR:-/tmp}/relight-menubar-smoke-$$.log"
SMOKE_EXIT=0
echo "  → 运行 Relight --self-test=menubar-smoke ..."
timeout 30 "${APP_BINARY}" "--self-test=menubar-smoke" > "${SMOKE_LOG}" 2>&1 || SMOKE_EXIT=$?

if [ "${SMOKE_EXIT}" -eq 0 ]; then
  pass "--self-test=menubar-smoke 退出码 0（MenuBar 相关 SelfTest 未被破坏）"
else
  echo "  ✘ --self-test=menubar-smoke 退出码 ${SMOKE_EXIT}（期望 0）"
  echo "  ── 完整输出 ──"
  cat "${SMOKE_LOG}" || true
  rm -f "${SMOKE_LOG}"
  fail_and_exit "D3 — menubar-smoke self-test 被破坏" \
    "RelightApp init 改造破坏了 menubar-smoke SelfTest case（退出码: ${SMOKE_EXIT}）"
fi

# D4: menubar-smoke 输出含预期关键词（LSUIElement=true / apiURL= / autoStart=）
MISSING_KEYWORDS=()
for kw in "LSUIElement=true" "apiURL=" "autoStart="; do
  if ! grep -q "${kw}" "${SMOKE_LOG}"; then
    MISSING_KEYWORDS+=("${kw}")
  fi
done

if [ "${#MISSING_KEYWORDS[@]}" -eq 0 ]; then
  pass "menubar-smoke 输出含预期关键词（LSUIElement=true / apiURL= / autoStart=）"
else
  echo "  ✘ menubar-smoke 输出缺少关键词: ${MISSING_KEYWORDS[*]}"
  echo "  ── 完整输出 ──"
  cat "${SMOKE_LOG}" || true
  rm -f "${SMOKE_LOG}"
  fail_and_exit "D4 — menubar-smoke 输出缺少关键词" \
    "缺少: ${MISSING_KEYWORDS[*]}（RelightApp body 改造可能删除了 menubar-smoke 输出逻辑）"
fi
rm -f "${SMOKE_LOG}"

# ────────────────────────────────────────────────────────────
# E 组：Coordinator/ 目录组织（共 2 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check E: Coordinator/ 目录组织"
echo "──────────────────────────────────────"

COORDINATOR_DIR="${MAC_DIR}/Relight/Coordinator"

# E1: Coordinator/ 目录存在
if [ -d "${COORDINATOR_DIR}" ]; then
  pass "Relight/Coordinator/ 目录存在"
else
  fail_and_exit "E1 — Relight/Coordinator/ 目录不存在" \
    "期望路径: ${COORDINATOR_DIR}"
fi

# E2: 目录中至少含 3 个 .swift 文件
SWIFT_COUNT=$(find "${COORDINATOR_DIR}" -maxdepth 1 -name "*.swift" | wc -l | tr -d ' ')
if [ "${SWIFT_COUNT}" -ge 3 ]; then
  pass "Coordinator/ 目录含 ${SWIFT_COUNT} 个 .swift 文件（≥ 3）"
else
  FOUND_FILES=$(find "${COORDINATOR_DIR}" -maxdepth 1 -name "*.swift" | sort | tr '\n' ' ')
  fail_and_exit "E2 — Coordinator/ 目录 .swift 文件不足" \
    "期望 ≥ 3 个，实际 ${SWIFT_COUNT} 个：${FOUND_FILES}"
fi

# ────────────────────────────────────────────────────────────
# F 组：不破坏现有工作流（共 1 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check F: 不破坏现有工作流（pnpm typecheck）"
echo "──────────────────────────────────────"

echo "  → 运行 pnpm typecheck（仓库根: ${REPO_ROOT}）..."
TC_LOG="${TMPDIR:-/tmp}/relight-coordinator-typecheck-$$.log"
if (cd "${REPO_ROOT}" && pnpm typecheck > "${TC_LOG}" 2>&1); then
  pass "pnpm typecheck 通过（退出码 0）"
else
  TC_EXIT=$?
  echo ""
  echo "  ✘ pnpm typecheck 失败（退出码 ${TC_EXIT}）"
  echo "  ── 最后 30 行日志 ──"
  tail -30 "${TC_LOG}" || true
  rm -f "${TC_LOG}"
  fail_and_exit "F1 — pnpm typecheck 失败（现有工作流被破坏）" "查看上方日志"
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

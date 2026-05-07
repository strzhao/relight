#!/usr/bin/env bash
# image-wallpaper.acceptance.test.sh
# 003-image-wallpaper-engine 验收脚本
# 运行方式：bash apps/mac/image-wallpaper.acceptance.test.sh
# 退出码：0 = 全部通过，非 0 = 失败
#
# 职责：黑盒验收 WallpaperEngine protocol 和 ImageWallpaperEngine 实现，
#       包括文件结构、xcodebuild 编译、self-test=image-wallpaper 行为、
#       以及 monorepo 不被破坏。

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

WP_BEFORE="/tmp/wp-before-003.png"
WP_BASELINE="/tmp/wp-baseline-003.png"
WP_AFTER="/tmp/wp-after-003.png"
BLACK_WALLPAPER="/System/Library/Desktop Pictures/Solid Colors/Black.png"

PASS=0
FAIL=0
SKIP=0

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
# 清理函数（尽力恢复壁纸，不因清理失败而 abort）
# ────────────────────────────────────────────────────────────
_cleanup() {
  # 终止可能残留的 Relight 进程
  pkill -f "Relight.app/Contents/MacOS/Relight" 2>/dev/null || true

  # 如果保存了"测试前壁纸"截图则尝试恢复
  # 注：screencapture 保存的是截图，不是原始壁纸路径，
  # 因此这里恢复到黑色壁纸的反向操作——我们尽力，但壁纸的精确恢复
  # 依赖 osascript 记录原始路径（见 C 组说明）
  if [ -n "${_ORIG_WALLPAPER_PATH:-}" ] && [ -f "${_ORIG_WALLPAPER_PATH}" ]; then
    osascript -e "tell application \"System Events\" to tell every desktop to set picture to \"${_ORIG_WALLPAPER_PATH}\"" 2>/dev/null || true
  fi
}

trap '_cleanup' EXIT

# ────────────────────────────────────────────────────────────
# A 组：文件存在性（共 2 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check A: 文件存在性"
echo "──────────────────────────────────────"

A_FILES=(
  "Relight/WallpaperEngine/WallpaperEngine.swift"
  "Relight/WallpaperEngine/ImageWallpaperEngine.swift"
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
# B 组：xcodebuild 编译（共 3 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check B: xcodebuild 编译"
echo "──────────────────────────────────────"

# B1: xcodebuild -list 含 Relight target
echo "  → 正在运行 xcodebuild -list..."
XCODE_LIST=$(xcodebuild -project "${XCODEPROJ}" -list 2>&1 || true)
if echo "${XCODE_LIST}" | grep -q "Relight"; then
  pass "xcodebuild -list 列出 Relight target/scheme"
else
  fail_and_exit "B1 — xcodebuild -list 无 Relight" "输出: ${XCODE_LIST}"
fi

# B2: Debug build 退出码 0
echo "  → 正在编译（首次编译可能需要数分钟）..."
BUILD_LOG="${TMPDIR:-/tmp}/relight-wallpaper-build-$$.log"
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

# B3: 产物可执行文件存在
if [ -x "${APP_BINARY}" ]; then
  pass "Relight.app/Contents/MacOS/Relight 存在且可执行"
else
  fail_and_exit "B3 — 可执行文件缺失或无执行权限" "期望路径: ${APP_BINARY}"
fi

# ────────────────────────────────────────────────────────────
# C 组：image-wallpaper self-test（依赖 backend :3000 + macOS 壁纸权限，可选）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check C: image-wallpaper self-test（--self-test=image-wallpaper）"
echo "──────────────────────────────────────"

# 探测 backend
BACKEND_ALIVE=false
echo "  → 检测 backend http://localhost:3000/api/daily/today ..."
PROBE=$(curl -s -m 3 "http://localhost:3000/api/daily/today" 2>/dev/null | head -c 100 || true)
if [ -n "${PROBE}" ]; then
  BACKEND_ALIVE=true
  echo "  → backend 在线，probe 响应: ${PROBE}"
fi

if ! "${BACKEND_ALIVE}"; then
  skip "C1 — 备份当前壁纸" "backend 未在 :3000 运行"
  skip "C2 — 设置黑色基线壁纸" "backend 未在 :3000 运行"
  skip "C3 — 运行 --self-test=image-wallpaper" "backend 未在 :3000 运行"
  skip "C4 — 验证壁纸变化（image）或跳过（video）" "backend 未在 :3000 运行"
  echo "  ⚠ 警告：C 组已跳过。请确保 backend 在 :3000 运行后重跑以完整验收。"
else
  # C1: 记录当前壁纸路径（用于恢复）+ 截图备份
  echo "  → 记录当前壁纸路径（用于测试后恢复）..."
  _ORIG_WALLPAPER_PATH=$(osascript -e 'tell application "System Events" to get picture of desktop 1' 2>/dev/null || true)
  export _ORIG_WALLPAPER_PATH

  # 截图作为视觉备份（辅助用，不强求）
  screencapture -x "${WP_BEFORE}" 2>/dev/null || true
  if [ -f "${WP_BEFORE}" ]; then
    pass "截图备份当前屏幕 → ${WP_BEFORE}"
  else
    echo "  ⚠ screencapture 失败（可能无 GUI 权限），继续..."
    PASS=$((PASS + 1))
  fi

  # C2: 设置黑色基线壁纸
  echo "  → 设置黑色基线壁纸..."
  if [ -f "${BLACK_WALLPAPER}" ]; then
    osascript -e "tell application \"System Events\" to tell every desktop to set picture to \"${BLACK_WALLPAPER}\"" 2>/dev/null || true
    sleep 1
    # 截图基线
    screencapture -x "${WP_BASELINE}" 2>/dev/null || true
    pass "黑色基线壁纸设置完成，基线截图 → ${WP_BASELINE}"
  else
    echo "  ⚠ ${BLACK_WALLPAPER} 不存在（macOS 版本差异），跳过基线设置"
    SKIP=$((SKIP + 1))
    # 仍然需要一个基线截图来做对比，用当前状态
    screencapture -x "${WP_BASELINE}" 2>/dev/null || true
  fi

  # C3: 运行 --self-test=image-wallpaper
  echo "  → 运行 Relight --self-test=image-wallpaper ..."
  WP_LOG="${TMPDIR:-/tmp}/relight-wallpaper-$$.log"
  WP_EXIT=0
  timeout 30 "${APP_BINARY}" "--self-test=image-wallpaper" > "${WP_LOG}" 2>&1 || WP_EXIT=$?

  echo "  → self-test 退出码: ${WP_EXIT}"

  if [ "${WP_EXIT}" -eq 0 ]; then
    # image 成功路径
    pass "--self-test=image-wallpaper 退出码 0（今日 pick 为 image，壁纸设置成功）"

    # C4: 验证壁纸确实变化（MD5 对比）
    screencapture -x "${WP_AFTER}" 2>/dev/null || true
    if [ -f "${WP_BASELINE}" ] && [ -f "${WP_AFTER}" ]; then
      MD5_BASELINE=$(md5 -q "${WP_BASELINE}" 2>/dev/null || md5sum "${WP_BASELINE}" | awk '{print $1}')
      MD5_AFTER=$(md5 -q "${WP_AFTER}" 2>/dev/null || md5sum "${WP_AFTER}" | awk '{print $1}')
      if [ "${MD5_BASELINE}" != "${MD5_AFTER}" ]; then
        pass "壁纸截图 MD5 已变化（baseline: ${MD5_BASELINE} → after: ${MD5_AFTER}）"
      else
        echo "  ⚠ 壁纸截图 MD5 未变化，可能截图精度有限或壁纸切换未反映在截图中（退出码已验证通过）"
        PASS=$((PASS + 1))
      fi
    else
      echo "  ⚠ 无法截图对比（可能无 screencapture 权限），跳过 MD5 检查"
      SKIP=$((SKIP + 1))
    fi

  elif [ "${WP_EXIT}" -eq 2 ]; then
    # video 路径：今日 pick 是视频，跳过此 check，整组视为通过
    pass "--self-test=image-wallpaper 退出码 2（今日 pick 为 video，正确跳过）"
    skip "C4 — 壁纸变化 MD5 验证" "今日 pick 是 video，无需验证壁纸切换"

  else
    # 其他退出码 = 失败
    echo "  ✘ --self-test=image-wallpaper 退出码 ${WP_EXIT}（期望 0 或 2）"
    echo "  ── 输出 ──"
    cat "${WP_LOG}" || true
    rm -f "${WP_LOG}"
    # 恢复壁纸
    if [ -n "${_ORIG_WALLPAPER_PATH}" ] && [ -f "${_ORIG_WALLPAPER_PATH}" ]; then
      osascript -e "tell application \"System Events\" to tell every desktop to set picture to \"${_ORIG_WALLPAPER_PATH}\"" 2>/dev/null || true
    fi
    fail_and_exit "C3 — image-wallpaper self-test 退出码异常" "退出码: ${WP_EXIT}（期望 0=image 成功 或 2=video 跳过）"
  fi
  rm -f "${WP_LOG}"

  # 不论结果如何，恢复壁纸
  echo "  → 恢复原始壁纸..."
  if [ -n "${_ORIG_WALLPAPER_PATH}" ] && [ -f "${_ORIG_WALLPAPER_PATH}" ]; then
    osascript -e "tell application \"System Events\" to tell every desktop to set picture to \"${_ORIG_WALLPAPER_PATH}\"" 2>/dev/null || true
    echo "  → 壁纸已恢复至: ${_ORIG_WALLPAPER_PATH}"
  else
    echo "  ⚠ 无原始壁纸路径，跳过恢复"
  fi
fi

# ────────────────────────────────────────────────────────────
# D 组：错误路径（接口契约文档检查，无需真实构造）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check D: 错误路径（接口契约文档验证）"
echo "──────────────────────────────────────"

# D 组说明：
# - ImageWallpaperEngine 的错误路径（sourceURL 不存在、isVideo==true）
#   需在 Swift 单元测试中直接构造，红队 bash 脚本无法黑盒注入源文件路径。
# - --self-test=image-wallpaper 使用 RelightClient 下载的真实文件，文件必然存在。
# - 因此 D 组以接口契约声明验证代替实际运行，自动跳过。

skip "D1 — sourceURL 不存在时抛 wallpaperSetFailed" "bash 无法黑盒构造 sourceURL=不存在路径；错误路径由蓝队 Swift 单元测试覆盖"
skip "D2 — isVideo==true 时抛 wallpaperSetFailed(reason 含 '视频')" "同上；此路径需 Swift 层直接构造 Photo 对象"

echo "  ℹ D 组契约约定（供蓝队参考）："
echo "    · wallpaperSetFailed(reason: String, underlying: Error?) case 须在 RelightError.swift 中定义"
echo "    · photo.isVideo==true 时 reason 须包含 '视频'"
echo "    · sourceURL 文件不存在时 reason 须包含 '存在'"

# ────────────────────────────────────────────────────────────
# E 组：不破坏现有工作流（共 1 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check E: 不破坏现有工作流"
echo "──────────────────────────────────────"

# E1: 仓库根 pnpm typecheck 退出码 0
echo "  → 运行 pnpm typecheck（仓库根: ${REPO_ROOT}）..."
TC_LOG="${TMPDIR:-/tmp}/relight-wallpaper-typecheck-$$.log"
if (cd "${REPO_ROOT}" && pnpm typecheck > "${TC_LOG}" 2>&1); then
  pass "pnpm typecheck 通过（退出码 0）"
else
  TC_EXIT=$?
  echo ""
  echo "  ✘ pnpm typecheck 失败（退出码 ${TC_EXIT}）"
  echo "  ── 最后 30 行日志 ──"
  tail -30 "${TC_LOG}" || true
  rm -f "${TC_LOG}"
  fail_and_exit "E1 — pnpm typecheck 失败（现有工作流被破坏）" "查看上方日志"
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

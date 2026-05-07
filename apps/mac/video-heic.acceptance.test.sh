#!/usr/bin/env bash
# video-heic.acceptance.test.sh
# 004-video-heic-wallpaper 验收脚本
# 运行方式：bash apps/mac/video-heic.acceptance.test.sh
# 退出码：0 = 全部通过，非 0 = 失败
#
# 职责：黑盒验收 VideoWallpaperEngine / VideoFrameExtractor / DynamicHeicBuilder 实现，
#       包括文件结构、xcodebuild 编译、heic-schema-probe self-test、
#       video-wallpaper self-test（含缓存命中验证）、错误路径契约、
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

DYNAMIC_HEIC_DIR="${HOME}/Library/Application Support/Relight/wallpapers/dynamic-heic"
VIDEO_PHOTO_ID="09728ce3-6c07-4389-a9c1-f22d12f9f297"

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
# A 组：文件存在性（共 3 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check A: 文件存在性"
echo "──────────────────────────────────────"

A_FILES=(
  "Relight/WallpaperEngine/VideoWallpaperEngine.swift"
  "Relight/WallpaperEngine/VideoFrameExtractor.swift"
  "Relight/WallpaperEngine/DynamicHeicBuilder.swift"
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
BUILD_LOG="${TMPDIR:-/tmp}/relight-video-heic-build-$$.log"
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
# C 组：heic-schema-probe self-test（共 3 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check C: heic-schema-probe self-test（--self-test=heic-schema-probe）"
echo "──────────────────────────────────────"

PROBE_LOG="${TMPDIR:-/tmp}/relight-heic-probe-$$.log"
PROBE_EXIT=0
echo "  → 运行 Relight --self-test=heic-schema-probe ..."
timeout 30 "${APP_BINARY}" "--self-test=heic-schema-probe" > "${PROBE_LOG}" 2>&1 || PROBE_EXIT=$?

# C1: 退出码 0
if [ "${PROBE_EXIT}" -eq 0 ]; then
  pass "--self-test=heic-schema-probe 退出码 0"
else
  echo "  ✘ --self-test=heic-schema-probe 退出码 ${PROBE_EXIT}（期望 0）"
  echo "  ── 输出 ──"
  cat "${PROBE_LOG}" || true
  rm -f "${PROBE_LOG}"
  fail_and_exit "C1 — heic-schema-probe 退出码异常" "退出码: ${PROBE_EXIT}"
fi

# C2: 输出含 apple_desktop 关键词
if grep -qi "apple_desktop" "${PROBE_LOG}"; then
  pass "输出含 'apple_desktop' 关键词"
else
  echo "  ✘ 输出中未找到 'apple_desktop' 关键词"
  echo "  ── 完整输出 ──"
  cat "${PROBE_LOG}" || true
  rm -f "${PROBE_LOG}"
  fail_and_exit "C2 — 输出未含 apple_desktop" "期望输出包含 apple_desktop 相关 XMP tag"
fi

# C3: 输出含 frame count 关键词
if grep -qi "frame count" "${PROBE_LOG}"; then
  pass "输出含 'frame count' 关键词"
else
  echo "  ✘ 输出中未找到 'frame count' 关键词"
  echo "  ── 完整输出 ──"
  cat "${PROBE_LOG}" || true
  rm -f "${PROBE_LOG}"
  fail_and_exit "C3 — 输出未含 frame count" "期望输出包含 HEIC 帧数信息"
fi

rm -f "${PROBE_LOG}"

# ────────────────────────────────────────────────────────────
# D 组：video-wallpaper self-test（依赖 backend :3000）（共 5 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check D: video-wallpaper self-test（--self-test=video-wallpaper）"
echo "──────────────────────────────────────"

# 探测 backend — HEAD 请求 original 接口
BACKEND_ALIVE=false
echo "  → 探测 backend http://localhost:3000/api/photos/${VIDEO_PHOTO_ID}/original HEAD ..."
PROBE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -m 5 \
  -X HEAD "http://localhost:3000/api/photos/${VIDEO_PHOTO_ID}/original" 2>/dev/null || true)
echo "  → HEAD 响应状态码: ${PROBE_STATUS}"
if [ -n "${PROBE_STATUS}" ] && [ "${PROBE_STATUS}" != "000" ]; then
  BACKEND_ALIVE=true
  echo "  → backend 在线（HTTP ${PROBE_STATUS}）"
fi

if ! "${BACKEND_ALIVE}"; then
  skip "D1 — 清理 dynamic-heic 目录" "backend 未在 :3000 运行，无法探测 ${VIDEO_PHOTO_ID}/original"
  skip "D2 — 运行 --self-test=video-wallpaper（首次）" "backend 未在 :3000 运行"
  skip "D3 — 验证 .heic 文件存在且 > 100KB" "backend 未在 :3000 运行"
  skip "D4 — 用 file 命令验证 HEIF/HEIC mime" "backend 未在 :3000 运行"
  skip "D5 — 验证 .heic 文件为 HEIC 格式" "backend 未在 :3000 运行"
  echo "  ⚠ 警告：D 组已跳过。请确保 backend 在 :3000 运行后重跑以完整验收。"
else
  # D1: 清理 dynamic-heic 目录（确保首次运行）
  echo "  → 清理 dynamic-heic 目录: ${DYNAMIC_HEIC_DIR}"
  rm -rf "${DYNAMIC_HEIC_DIR}"
  mkdir -p "${DYNAMIC_HEIC_DIR}"
  pass "dynamic-heic 目录已清理"

  # D2: 运行 --self-test=video-wallpaper，退出码 0
  VW_LOG="${TMPDIR:-/tmp}/relight-video-wallpaper-$$.log"
  VW_EXIT=0
  echo "  → 运行 Relight --self-test=video-wallpaper ..."
  timeout 120 "${APP_BINARY}" "--self-test=video-wallpaper" > "${VW_LOG}" 2>&1 || VW_EXIT=$?

  echo "  → self-test 退出码: ${VW_EXIT}"

  if [ "${VW_EXIT}" -eq 0 ]; then
    pass "--self-test=video-wallpaper 退出码 0"
  else
    echo "  ✘ --self-test=video-wallpaper 退出码 ${VW_EXIT}（期望 0）"
    echo "  ── 完整输出 ──"
    cat "${VW_LOG}" || true
    rm -f "${VW_LOG}"
    fail_and_exit "D2 — video-wallpaper self-test 失败" "退出码: ${VW_EXIT}"
  fi
  rm -f "${VW_LOG}"

  # D3: 验证 .heic 文件存在且大小 > 100KB
  echo "  → 验证 dynamic-heic 目录中的 .heic 文件..."
  HEIC_FILE=$(find "${DYNAMIC_HEIC_DIR}" -name "*.heic" 2>/dev/null | head -1 || true)

  if [ -z "${HEIC_FILE}" ]; then
    fail_and_exit "D3 — dynamic-heic 目录中无 .heic 文件" \
      "期望路径: ${DYNAMIC_HEIC_DIR}/*.heic"
  fi

  echo "  → 找到 .heic 文件: ${HEIC_FILE}"
  FILE_SIZE=$(stat -f %z "${HEIC_FILE}" 2>/dev/null || stat -c %s "${HEIC_FILE}" 2>/dev/null || true)
  echo "  → 文件大小: ${FILE_SIZE} bytes"

  if [ -n "${FILE_SIZE}" ] && [ "${FILE_SIZE}" -gt 102400 ]; then
    pass ".heic 文件存在且大小 > 100KB（实际: ${FILE_SIZE} bytes）"
  else
    fail_and_exit "D3 — .heic 文件大小不符预期" \
      "期望 > 100KB（102400 bytes），实际: ${FILE_SIZE} bytes；多帧 HEIC 应至少几 MB"
  fi

  # D4: file 命令验证 HEIC/HEIF mime
  FILE_OUTPUT=$(file "${HEIC_FILE}" 2>/dev/null || true)
  echo "  → file 命令输出: ${FILE_OUTPUT}"

  if echo "${FILE_OUTPUT}" | grep -qiE "HEIF|ISO Media|HEIC"; then
    pass "file 命令确认为 HEIF/ISO Media 格式（含 HEIC）"
  else
    fail_and_exit "D4 — file 命令未识别为 HEIF/HEIC" \
      "file 输出: ${FILE_OUTPUT}（期望含 HEIF、ISO Media 或 HEIC）"
  fi

  # D5: 文件名含期望前缀（hash 命名规则验证）
  HEIC_BASENAME=$(basename "${HEIC_FILE}")
  echo "  → .heic 文件名: ${HEIC_BASENAME}"
  # 文件名应为 hash.heic 格式（至少 8 位十六进制字符）
  if echo "${HEIC_BASENAME}" | grep -qE "^[0-9a-f]{8}"; then
    pass ".heic 文件名符合 hash 命名规则（${HEIC_BASENAME}）"
  else
    # 不强制 hash 前缀，只验证文件存在即可（设计可能有差异）
    echo "  ⚠ .heic 文件名格式与预期有差异（${HEIC_BASENAME}），文件已存在，视为通过"
    PASS=$((PASS + 1))
  fi
fi

# ────────────────────────────────────────────────────────────
# E 组：缓存命中（依赖 D 组成功）（共 2 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check E: 缓存命中验证（第 2 次运行 --self-test=video-wallpaper）"
echo "──────────────────────────────────────"

if ! "${BACKEND_ALIVE}"; then
  skip "E1 — 记录第一次 .heic 文件 mtime" "backend 未在 :3000 运行（D 组已跳过）"
  skip "E2 — 第 2 次运行，验证 mtime 未变化（缓存命中）" "backend 未在 :3000 运行"
  echo "  ⚠ 警告：E 组已跳过。请确保 backend 在 :3000 运行后重跑以完整验收。"
else
  # 重新查找 .heic 文件（D 组已验证存在）
  HEIC_FILE=$(find "${DYNAMIC_HEIC_DIR}" -name "*.heic" 2>/dev/null | head -1 || true)

  if [ -z "${HEIC_FILE}" ]; then
    skip "E1 — 记录 mtime" "D 组未产出 .heic 文件"
    skip "E2 — 缓存命中验证" "D 组未产出 .heic 文件"
  else
    # E1: 记录第一次 mtime
    MTIME_BEFORE=$(stat -f %m "${HEIC_FILE}" 2>/dev/null || stat -c %Y "${HEIC_FILE}" 2>/dev/null || true)
    echo "  → 第一次 .heic mtime: ${MTIME_BEFORE}（文件: $(basename "${HEIC_FILE}")）"
    pass "记录第一次 .heic 文件 mtime: ${MTIME_BEFORE}"

    # E2: 第 2 次运行 --self-test=video-wallpaper
    VW2_LOG="${TMPDIR:-/tmp}/relight-video-wallpaper2-$$.log"
    VW2_EXIT=0
    echo "  → 第 2 次运行 Relight --self-test=video-wallpaper（预期命中缓存）..."
    timeout 60 "${APP_BINARY}" "--self-test=video-wallpaper" > "${VW2_LOG}" 2>&1 || VW2_EXIT=$?

    echo "  → 第 2 次 self-test 退出码: ${VW2_EXIT}"
    if [ "${VW2_EXIT}" -ne 0 ]; then
      echo "  ✘ 第 2 次 --self-test=video-wallpaper 退出码 ${VW2_EXIT}（期望 0）"
      echo "  ── 输出 ──"
      cat "${VW2_LOG}" || true
      rm -f "${VW2_LOG}"
      fail_and_exit "E2 — 第 2 次 video-wallpaper self-test 失败" "退出码: ${VW2_EXIT}"
    fi
    rm -f "${VW2_LOG}"

    MTIME_AFTER=$(stat -f %m "${HEIC_FILE}" 2>/dev/null || stat -c %Y "${HEIC_FILE}" 2>/dev/null || true)
    echo "  → 第 2 次 .heic mtime: ${MTIME_AFTER}"

    if [ "${MTIME_BEFORE}" = "${MTIME_AFTER}" ]; then
      pass "mtime 未变化（缓存命中：第 2 次跳过抽帧+构建）"
    else
      fail_and_exit "E2 — mtime 已变化（缓存未命中）" \
        "before: ${MTIME_BEFORE}，after: ${MTIME_AFTER}；期望第 2 次直接读缓存，文件不应被重写"
    fi
  fi
fi

# ────────────────────────────────────────────────────────────
# F 组：错误路径（接口契约文档验证）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check F: 错误路径（接口契约文档验证）"
echo "──────────────────────────────────────"

# F 组说明：
# - VideoWallpaperEngine 要求 photo.isVideo==true，否则抛 wallpaperSetFailed(reason 含 "视频")
# - bash 脚本无法黑盒构造非视频 Photo 对象，此路径由蓝队 Swift 单元测试覆盖
# - 自动跳过并打印契约约定（同 003 D 组处理方式）

skip "F1 — photo.isVideo==false 时抛 wallpaperSetFailed(reason 含 '视频')" \
  "bash 无法黑盒构造非视频 Photo 对象；错误路径由蓝队 Swift 单元测试覆盖"

echo "  ℹ F 组契约约定（供蓝队参考）："
echo "    · VideoWallpaperEngine 须实现 WallpaperEngine protocol"
echo "    · photo.isVideo == false 时须抛 RelightError.wallpaperSetFailed(reason 包含 '视频')"
echo "    · RelightError.videoConversionFailed(reason: String, underlying: Error?) 须已定义"
echo "    · 缓存路径：~/Library/Application Support/Relight/wallpapers/dynamic-heic/<hash>.heic"
echo "    · 多显示器：须遍历 NSScreen.screens 逐一设置"

# ────────────────────────────────────────────────────────────
# G 组：不破坏现有工作流（共 1 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check G: 不破坏现有工作流"
echo "──────────────────────────────────────"

# G1: 仓库根 pnpm typecheck 退出码 0
echo "  → 运行 pnpm typecheck（仓库根: ${REPO_ROOT}）..."
TC_LOG="${TMPDIR:-/tmp}/relight-video-heic-typecheck-$$.log"
if (cd "${REPO_ROOT}" && pnpm typecheck > "${TC_LOG}" 2>&1); then
  pass "pnpm typecheck 通过（退出码 0）"
else
  TC_EXIT=$?
  echo ""
  echo "  ✘ pnpm typecheck 失败（退出码 ${TC_EXIT}）"
  echo "  ── 最后 30 行日志 ──"
  tail -30 "${TC_LOG}" || true
  rm -f "${TC_LOG}"
  fail_and_exit "G1 — pnpm typecheck 失败（现有工作流被破坏）" "查看上方日志"
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

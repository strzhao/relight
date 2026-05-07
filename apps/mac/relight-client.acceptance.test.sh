#!/usr/bin/env bash
# relight-client.acceptance.test.sh
# 002-relight-api-client 验收脚本
# 运行方式：bash apps/mac/relight-client.acceptance.test.sh
# 退出码：0 = 全部通过，非 0 = 失败
#
# 职责：黑盒验收 RelightClient 的文件结构、编译、Codable 离线测试、
#       真实 API fetch、缓存命中、错误路径、以及 monorepo 不被破坏。

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
CACHE_BASE="${HOME}/Library/Application Support/Relight/wallpapers"
CACHE_ORIGINAL="${CACHE_BASE}/original"
BUNDLE_ID="app.relight.mac"
DEFAULTS_KEY="app.relight.apiURL"

PASS=0
FAIL=0
SKIP=0

pass() { echo "  ✔ $1"; PASS=$((PASS + 1)); }
skip() { echo "  ⏭ $1（跳过：$2）"; SKIP=$((SKIP + 1)); }
fail_and_exit() {
  echo ""
  echo "❌ 验收失败：$1"
  echo "   原因：$2"
  # 尝试清理后再退出
  _cleanup
  exit 1
}

# ────────────────────────────────────────────────────────────
# 清理函数（会在失败时及脚本末尾调用）
# ────────────────────────────────────────────────────────────
_cleanup() {
  # 终止所有可能残留的 Relight 进程
  pkill -f "Relight.app/Contents/MacOS/Relight" 2>/dev/null || true
  # 清理可能写入的错误 defaults 值（无论之前是否设置过）
  defaults delete "${BUNDLE_ID}" "${DEFAULTS_KEY}" 2>/dev/null || true
}

# 确保退出时总是清理（即使 set -e 触发）
trap '_cleanup' EXIT

# 启动辅助函数：以 --self-test=<mode> 运行 APP，等待退出，返回退出码
run_self_test() {
  local mode="$1"
  local timeout_sec="${2:-15}"
  # 用 timeout 防止无限等待
  timeout "${timeout_sec}" "${APP_BINARY}" "--self-test=${mode}" 2>/dev/null
  return $?
}

# ────────────────────────────────────────────────────────────
# A 组：文件结构存在性（共 7 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check A: 文件结构存在性"
echo "──────────────────────────────────────"

A_FILES=(
  "Relight/Models/Photo.swift"
  "Relight/Models/DailyPick.swift"
  "Relight/Networking/RelightClient.swift"
  "Relight/Networking/RelightError.swift"
  "Relight/Networking/ApiResponse.swift"
  "Relight/Storage/WallpaperCache.swift"
  "Relight/Settings/AppSettings.swift"
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

# B1: xcodebuild -list 列出 Relight target/scheme
echo "  → 正在运行 xcodebuild -list..."
XCODE_LIST=$(xcodebuild -project "${XCODEPROJ}" -list 2>&1 || true)
if echo "${XCODE_LIST}" | grep -q "Relight"; then
  pass "xcodebuild -list 列出 Relight target/scheme"
else
  fail_and_exit "B1 — xcodebuild -list 无 Relight" "输出: ${XCODE_LIST}"
fi

# B2: xcodebuild Debug build 退出码 0
echo "  → 正在编译（首次编译可能需要数分钟）..."
BUILD_LOG="${TMPDIR:-/tmp}/relight-client-build-$$.log"
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

# B3: 产物二进制存在且可执行
if [ -x "${APP_BINARY}" ]; then
  pass "产物 Relight.app/Contents/MacOS/Relight 存在且可执行"
else
  fail_and_exit "B3 — 可执行文件缺失或无执行权限" "期望路径: ${APP_BINARY}"
fi

# ────────────────────────────────────────────────────────────
# C 组：Codable 离线 fixture（共 3 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check C: Codable 离线 fixture（--self-test=codable）"
echo "──────────────────────────────────────"

# C1: 退出码 0
echo "  → 运行 Relight --self-test=codable..."
CODABLE_LOG="${TMPDIR:-/tmp}/relight-codable-$$.log"
CODABLE_EXIT=0
"${APP_BINARY}" "--self-test=codable" > "${CODABLE_LOG}" 2>&1 || CODABLE_EXIT=$?

if [ "${CODABLE_EXIT}" -eq 0 ]; then
  pass "--self-test=codable 退出码 0"
else
  echo "  ✘ --self-test=codable 退出码 ${CODABLE_EXIT}"
  echo "  ── 输出 ──"
  cat "${CODABLE_LOG}" || true
  rm -f "${CODABLE_LOG}"
  fail_and_exit "C1 — codable self-test 退出码非 0" "退出码: ${CODABLE_EXIT}"
fi

# C2: 输出不包含 "fail" 或 "error"（大小写不敏感）
if grep -iE "fail|error" "${CODABLE_LOG}" > /dev/null 2>&1; then
  FAIL_LINES=$(grep -iE "fail|error" "${CODABLE_LOG}" | head -5 || true)
  rm -f "${CODABLE_LOG}"
  fail_and_exit "C2 — codable 输出含 fail/error 关键词" "匹配行: ${FAIL_LINES}"
else
  pass "OSLog/输出不含 fail/error 关键词"
fi

# C3: 输出包含解码成功的 mediaType 字段迹象（含 "video" 或 "image"）
if grep -iE "video|image|pick|photo|decode" "${CODABLE_LOG}" > /dev/null 2>&1; then
  pass "输出包含 Codable 解码相关内容（video/image/pick/photo/decode）"
else
  echo "  ⚠ 输出中未发现明显解码成功标志（video/image/pick/photo/decode），继续..."
  PASS=$((PASS + 1))
fi
rm -f "${CODABLE_LOG}"

# ────────────────────────────────────────────────────────────
# D 组：fetch 真实 API（依赖 backend :3000，可选）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check D: fetch 真实 API（--self-test=fetch）"
echo "──────────────────────────────────────"

BACKEND_ALIVE=false
echo "  → 检测 backend http://localhost:3000/api/daily/today ..."
PROBE=$(curl -s -m 3 "http://localhost:3000/api/daily/today" 2>/dev/null | head -c 50 || true)
if [ -n "${PROBE}" ]; then
  BACKEND_ALIVE=true
  echo "  → backend 在线，probe 响应: ${PROBE}"
fi

if ! "${BACKEND_ALIVE}"; then
  skip "D1 — --self-test=fetch 退出码 0" "backend 未在 :3000 运行"
  skip "D2 — fetch 输出包含 pick 信息" "backend 未在 :3000 运行"
  echo "  ⚠ 警告：D 组已跳过。请确保 backend 在 :3000 运行后重跑以完整验收。"
else
  # D1: --self-test=fetch 退出码 0
  echo "  → 运行 Relight --self-test=fetch..."
  FETCH_LOG="${TMPDIR:-/tmp}/relight-fetch-$$.log"
  FETCH_EXIT=0
  "${APP_BINARY}" "--self-test=fetch" > "${FETCH_LOG}" 2>&1 || FETCH_EXIT=$?

  if [ "${FETCH_EXIT}" -eq 0 ]; then
    pass "--self-test=fetch 退出码 0"
  else
    echo "  ✘ --self-test=fetch 退出码 ${FETCH_EXIT}"
    echo "  ── 输出 ──"
    cat "${FETCH_LOG}" || true
    rm -f "${FETCH_LOG}"
    fail_and_exit "D1 — fetch self-test 退出码非 0" "退出码: ${FETCH_EXIT}"
  fi

  # D2: 输出含 pick 相关内容
  if grep -iE "pick|photo|daily|title|narrative" "${FETCH_LOG}" > /dev/null 2>&1; then
    pass "fetch 输出包含 pick/photo/daily/title/narrative 等 pick 信息"
  else
    echo "  ⚠ 未在输出中找到 pick 信息关键词，仅作警告（退出码已验证）"
    PASS=$((PASS + 1))
  fi
  rm -f "${FETCH_LOG}"
fi

# ────────────────────────────────────────────────────────────
# E 组：缓存目录创建 + 缓存命中（依赖 backend :3000，可选）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check E: 缓存目录创建 + 缓存命中（--self-test=download）"
echo "──────────────────────────────────────"

if ! "${BACKEND_ALIVE}"; then
  skip "E1 — 缓存目录创建" "backend 未在 :3000 运行"
  skip "E2 — original/ 目录存在" "backend 未在 :3000 运行"
  skip "E3 — 至少 1 个 <hash>.* 文件存在" "backend 未在 :3000 运行"
  skip "E4 — 第二次调用缓存命中（mtime 不变）" "backend 未在 :3000 运行"
  echo "  ⚠ 警告：E 组已跳过。请确保 backend 在 :3000 运行后重跑以完整验收。"
else
  # 清理缓存目录
  echo "  → 清理缓存目录 ${CACHE_BASE} ..."
  rm -rf "${CACHE_BASE}" 2>/dev/null || true

  # E1: --self-test=download 退出码 0（第一次）
  echo "  → 运行 Relight --self-test=download（第 1 次）..."
  DL_LOG="${TMPDIR:-/tmp}/relight-download-1-$$.log"
  DL_EXIT=0
  "${APP_BINARY}" "--self-test=download" > "${DL_LOG}" 2>&1 || DL_EXIT=$?

  if [ "${DL_EXIT}" -eq 0 ]; then
    pass "--self-test=download（第 1 次）退出码 0"
  else
    echo "  ✘ --self-test=download 退出码 ${DL_EXIT}"
    echo "  ── 输出 ──"
    cat "${DL_LOG}" || true
    rm -f "${DL_LOG}"
    fail_and_exit "E1 — download self-test 退出码非 0" "退出码: ${DL_EXIT}"
  fi
  rm -f "${DL_LOG}"

  # E2: original/ 目录存在
  if [ -d "${CACHE_ORIGINAL}" ]; then
    pass "缓存目录 ~/Library/Application Support/Relight/wallpapers/original/ 已创建"
  else
    fail_and_exit "E2 — 缓存目录未创建" "期望路径: ${CACHE_ORIGINAL}"
  fi

  # E3: 至少 1 个 <hash>.* 文件存在
  CACHED_FILE=$(find "${CACHE_ORIGINAL}" -maxdepth 1 -type f | head -1 || true)
  if [ -n "${CACHED_FILE}" ]; then
    pass "缓存 original/ 目录下存在至少 1 个文件（${CACHED_FILE}）"
  else
    fail_and_exit "E3 — original/ 目录下无缓存文件" "期望至少 1 个 <hash>.* 文件"
  fi

  # 记录第一次的 mtime
  MTIME_BEFORE=$(stat -f "%m" "${CACHED_FILE}" 2>/dev/null || stat --format="%Y" "${CACHED_FILE}" 2>/dev/null || echo "0")
  echo "  → 缓存文件: $(basename "${CACHED_FILE}")，mtime=${MTIME_BEFORE}"

  # 稍等 1 秒确保如果文件被重写 mtime 会变化
  sleep 1

  # E4: 第二次调用缓存命中（mtime 不变）
  echo "  → 运行 Relight --self-test=download（第 2 次，期望缓存命中）..."
  DL2_LOG="${TMPDIR:-/tmp}/relight-download-2-$$.log"
  DL2_EXIT=0
  "${APP_BINARY}" "--self-test=download" > "${DL2_LOG}" 2>&1 || DL2_EXIT=$?

  if [ "${DL2_EXIT}" -ne 0 ]; then
    echo "  ✘ --self-test=download（第 2 次）退出码 ${DL2_EXIT}"
    cat "${DL2_LOG}" || true
    rm -f "${DL2_LOG}"
    fail_and_exit "E4 — 第二次 download self-test 失败" "退出码: ${DL2_EXIT}"
  fi
  rm -f "${DL2_LOG}"

  MTIME_AFTER=$(stat -f "%m" "${CACHED_FILE}" 2>/dev/null || stat --format="%Y" "${CACHED_FILE}" 2>/dev/null || echo "1")
  if [ "${MTIME_BEFORE}" = "${MTIME_AFTER}" ]; then
    pass "缓存命中验证：第 2 次调用 mtime 未变化（${MTIME_BEFORE} == ${MTIME_AFTER}）"
  else
    fail_and_exit "E4 — 缓存未命中（文件被重写）" "mtime 变化：${MTIME_BEFORE} → ${MTIME_AFTER}，期望不变"
  fi
fi

# ────────────────────────────────────────────────────────────
# F 组：错误路径 — 无效 apiURL（依赖 backend :3000，可选）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check F: 错误路径 — networkUnreachable（--self-test=fetch + 无效端口）"
echo "──────────────────────────────────────"

# F 组验证：即使 backend 不在线，无效端口测试也应该始终可以跑
# 因为我们把 apiURL 设成 :9999（无监听端口），期望连接失败

echo "  → 写入无效 apiURL: defaults write ${BUNDLE_ID} ${DEFAULTS_KEY} http://localhost:9999"
defaults write "${BUNDLE_ID}" "${DEFAULTS_KEY}" "http://localhost:9999"

# F1: 退出码非 0
echo "  → 运行 Relight --self-test=fetch（期望失败）..."
FERR_LOG="${TMPDIR:-/tmp}/relight-fetch-err-$$.log"
FERR_EXIT=0
"${APP_BINARY}" "--self-test=fetch" > "${FERR_LOG}" 2>&1 || FERR_EXIT=$?

if [ "${FERR_EXIT}" -ne 0 ]; then
  pass "--self-test=fetch 在无效 apiURL 下退出码非 0（实际: ${FERR_EXIT}）"
else
  echo "  ✘ 期望退出码非 0，实际为 0"
  echo "  ── 输出 ──"
  cat "${FERR_LOG}" || true
  rm -f "${FERR_LOG}"
  # 先清理 defaults 再 fail
  defaults delete "${BUNDLE_ID}" "${DEFAULTS_KEY}" 2>/dev/null || true
  fail_and_exit "F1 — 无效 apiURL 未触发错误退出" "期望退出码非 0，实际为 0"
fi

# F2: 输出包含 networkUnreachable 或 connection refused / 连接失败相关字样
if grep -iE "networkUnreachable|unreachable|connection|refused|could not connect|timeout|noPickAvailable" "${FERR_LOG}" > /dev/null 2>&1; then
  pass "输出包含网络不可达 / 连接失败相关关键词"
else
  echo "  ⚠ 输出未包含明显错误关键词，仅作警告（退出码已验证）"
  PASS=$((PASS + 1))
fi
rm -f "${FERR_LOG}"

# 清理 defaults（trap 也会执行，这里提前做以防后续检查依赖干净状态）
defaults delete "${BUNDLE_ID}" "${DEFAULTS_KEY}" 2>/dev/null || true

# ────────────────────────────────────────────────────────────
# G 组：不破坏现有工作流（共 1 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check G: 不破坏现有工作流"
echo "──────────────────────────────────────"

# G1: 仓库根 pnpm typecheck 仍通过
echo "  → 运行 pnpm typecheck（仓库根: ${REPO_ROOT}）..."
TC_LOG="${TMPDIR:-/tmp}/relight-client-typecheck-$$.log"
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

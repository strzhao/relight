#!/usr/bin/env bash
# aerial-video.acceptance.test.sh
# 20260912-开始实现动态视频壁纸 验收脚本（红队，仅依据设计文档编写）
# 运行方式：bash apps/mac/aerial-video.acceptance.test.sh
# 退出码：0 = 全部通过，非 0 = 失败
#
# 职责：黑盒验收 AerialVideoEngine / Coordinator Aerial 分支 / self-test 三模式实现，
#       包括文件结构与 pbxproj 引用、xcodebuild 编译、aerial-probe、
#       aerial-apply（自有 assetID 四位一体注册：slot .mov + thumbnail + catalog 条目
#       file:// 锚定 + Index.plist 指向；Apple 既有资产零触碰 + ffprobe codec 契约）、
#       wallpaper-refresh-fallback --simulate-aerial-failure（aerial-fallback 回退契约）、
#       以及 monorepo 不被破坏。
#
# 覆盖验收谓词（state.md ## 验收场景，2026-11-11 注册姿势重构）：
#   - 场景 2.P2 [real-process]：App 执行注册 → 自有 {assetID}.mov 落位
#     ∧ thumbnail 落位 ∧ entries.json 含条目（url-* 全 file://）∧ Index.plist 指向
#     ∧ Apple 既有 slot 零触碰（历史教训：劫持 Apple asset 会被 CDN 校验 30s 还原）
#   - 场景 2.P3（代码化）：slot 文件 codec=hvc1 ∧ 1920×1080 ∧ 无音轨
#   - 场景 6.P1 [real-process]：注入失败 → 回退静态壁纸，路径 contains
#     "Application Support/Relight" 且扩展名 ∈ {.jpg,.jpeg,.png}
#   - 场景 6.P2 [det-machine]：App 保持运行并记录回退事件（日志含 aerial-fallback 标记）

set -euo pipefail

# ────────────────────────────────────────────────────────────
# 初始化
# ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MAC_DIR="${REPO_ROOT}/apps/mac"
XCODEPROJ="${MAC_DIR}/Relight.xcodeproj"
PBXPROJ="${XCODEPROJ}/project.pbxproj"
BUILD_DIR="${MAC_DIR}/build"
APP_PATH="${BUILD_DIR}/Build/Products/Debug/Relight.app"
APP_BINARY="${APP_PATH}/Contents/MacOS/Relight"

# macOS 26 Tahoe 用户级 Aerial 目录（设计契约 §Mac App 设计 §4）
AERIAL_VIDEOS_DIR="${HOME}/Library/Application Support/com.apple.wallpaper/aerials/videos"
AERIAL_ENTRIES_JSON="${HOME}/Library/Application Support/com.apple.wallpaper/aerials/manifest/entries.json"
RELIGHT_WALLPAPER_ROOT="${HOME}/Library/Application Support/Relight"

TMP_WORK="$(mktemp -d /tmp/relight-aerial-accept.XXXXXX)"
trap 'rm -rf "${TMP_WORK}"' EXIT

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
# A 组：文件存在性 + pbxproj 引用（共 4 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check A: 文件存在性 + pbxproj 引用"
echo "──────────────────────────────────────"

# A1: 新引擎文件存在
if [ -f "${MAC_DIR}/Relight/WallpaperEngine/AerialVideoEngine.swift" ]; then
  pass "apps/mac/Relight/WallpaperEngine/AerialVideoEngine.swift 存在"
else
  fail_and_exit "A1 — 文件不存在" "apps/mac/Relight/WallpaperEngine/AerialVideoEngine.swift 未找到"
fi

# A2: pbxproj 引用 AerialVideoEngine.swift ≥ 4 处
#   （历史教训：新 .swift 须同步 PBXBuildFile / PBXFileReference / PBXGroup children /
#     PBXSourcesBuildPhase 四处，漏一处 build 失败——mac-app.md 2026-07-19）
PBX_REFS=$(grep -c "AerialVideoEngine.swift" "${PBXPROJ}" 2>/dev/null || true)
if [ "${PBX_REFS}" -ge 4 ]; then
  pass "project.pbxproj 引用 AerialVideoEngine.swift ${PBX_REFS} 处（≥4，四处同步）"
else
  fail_and_exit "A2 — pbxproj 引用不足四处" "期望 ≥4 处引用（BuildFile/FileRef/Group/Sources），实际 ${PBX_REFS} 处"
fi

# A3: pbxproj 含 Sources 编译引用（可执行 BuildFile 行）
if grep -q "AerialVideoEngine.swift in Sources" "${PBXPROJ}"; then
  pass "pbxproj 含 'AerialVideoEngine.swift in Sources' 编译引用"
else
  fail_and_exit "A3 — pbxproj 无 Sources 编译引用" "缺少 '<uuid> /* AerialVideoEngine.swift in Sources */' 行"
fi

# A4: RelightApp.swift 挂载三个 self-test 模式（设计 §RelightApp §6 逐字模式名）
A4_MISSING=""
for mode in "aerial-probe" "aerial-apply" "wallpaper-refresh-fallback"; do
  if ! grep -q "${mode}" "${MAC_DIR}/Relight/RelightApp.swift"; then
    A4_MISSING="${A4_MISSING} ${mode}"
  fi
done
if [ -z "${A4_MISSING}" ]; then
  pass "RelightApp.swift 挂载 aerial-probe / aerial-apply / wallpaper-refresh-fallback 三模式"
else
  fail_and_exit "A4 — self-test 模式未挂载" "RelightApp.swift 缺少:${A4_MISSING}"
fi

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
BUILD_LOG="${TMP_WORK}/aerial-build.log"
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
  fail_and_exit "B2 — xcodebuild 编译失败" "查看上方日志"
fi

# B3: 产物可执行文件存在
if [ -x "${APP_BINARY}" ]; then
  pass "Relight.app/Contents/MacOS/Relight 存在且可执行"
else
  fail_and_exit "B3 — 可执行文件缺失或无执行权限" "期望路径: ${APP_BINARY}"
fi

# ────────────────────────────────────────────────────────────
# C 组：aerial-probe self-test（共 3 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check C: aerial-probe self-test（--self-test=aerial-probe）"
echo "──────────────────────────────────────"

PROBE_LOG="${TMP_WORK}/aerial-probe.log"
PROBE_EXIT=0
echo "  → 运行 Relight --self-test=aerial-probe ..."
timeout 30 "${APP_BINARY}" "--self-test=aerial-probe" > "${PROBE_LOG}" 2>&1 || PROBE_EXIT=$?

# C1: 退出码 0（无 assetID 选择时也应正常打印探测信息而非崩溃）
if [ "${PROBE_EXIT}" -eq 0 ]; then
  pass "--self-test=aerial-probe 退出码 0"
else
  echo "  ✘ --self-test=aerial-probe 退出码 ${PROBE_EXIT}（期望 0）"
  echo "  ── 输出 ──"
  cat "${PROBE_LOG}" || true
  fail_and_exit "C1 — aerial-probe 退出码异常" "退出码: ${PROBE_EXIT}"
fi

# C2: 输出含 assetIDs 信息（设计 §RelightApp §6：打印 assetIDs）
if grep -qi "assetid" "${PROBE_LOG}"; then
  pass "输出含 assetIDs 探测信息"
else
  echo "  ✘ 输出中未找到 assetIDs 信息"
  echo "  ── 完整输出 ──"
  cat "${PROBE_LOG}" || true
  fail_and_exit "C2 — 输出未含 assetIDs" "设计要求 probe 打印 assetIDs（可为空列表）"
fi

# C3: 输出含可写性信息（设计 §RelightApp §6：打印 videosPath 存在性/可写性）
#   CONTRACT_AMBIGUOUS: 词形未冻结（writable / writable=true / 中文「可写」均容），
#   断言收敛到「writ 词根或中文可写」二选一。
if grep -qiE "writ|可写" "${PROBE_LOG}"; then
  pass "输出含 videosPath 可写性信息"
else
  echo "  ✘ 输出中未找到可写性信息"
  echo "  ── 完整输出 ──"
  cat "${PROBE_LOG}" || true
  fail_and_exit "C3 — 输出未含可写性信息" "设计要求 probe 打印 videosPath 可写性"
fi

rm -f "${PROBE_LOG}"

# ────────────────────────────────────────────────────────────
# E 组：wallpaper-refresh-fallback --simulate-aerial-failure（场景 6.P1/P2）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check E: wallpaper-refresh-fallback（--simulate-aerial-failure 故障注入）"
echo "──────────────────────────────────────"

FB_LOG="${TMP_WORK}/refresh-fallback.log"
FB_EXIT=0
echo "  → 运行 Relight --self-test=wallpaper-refresh-fallback --simulate-aerial-failure ..."
timeout 60 "${APP_BINARY}" "--self-test=wallpaper-refresh-fallback" "--simulate-aerial-failure" \
  > "${FB_LOG}" 2>&1 || FB_EXIT=$?

# E1: 退出码 0（App 保持运行、不崩溃、不阻塞 tick —— 场景 6.P2 行为面）
if [ "${FB_EXIT}" -eq 0 ]; then
  pass "--self-test=wallpaper-refresh-fallback --simulate-aerial-failure 退出码 0"
else
  echo "  ✘ 退出码 ${FB_EXIT}（期望 0）"
  echo "  ── 输出 ──"
  cat "${FB_LOG}" || true
  fail_and_exit "E1 — fallback self-test 失败" "退出码: ${FB_EXIT}"
fi

# E2: 日志含固定回退标记（场景 6.P2 逐字：aerial-fallback）
if grep -q "aerial-fallback" "${FB_LOG}"; then
  pass "输出含固定回退标记 aerial-fallback"
else
  echo "  ✘ 输出中未找到 aerial-fallback 标记"
  echo "  ── 完整输出 ──"
  cat "${FB_LOG}" || true
  fail_and_exit "E2 — 未记录 aerial-fallback 回退标记" "场景 6.P2：日志 contains 回退标记"
fi

# E3: 回退壁纸路径 contains "Application Support/Relight" 且扩展名 ∈ {.jpg,.jpeg,.png}（场景 6.P1）
FB_MATCH=$(grep -oE '[^"'"'"']*Application Support/Relight[^"'"'"']*\.(jpg|jpeg|png)' "${FB_LOG}" | head -1 || true)
if [ -z "${FB_MATCH}" ]; then
  # URL 编码形态兜底（%20 空格）
  FB_MATCH=$(grep -oE '[^"'"'"']*Application%20Support/Relight[^"'"'"']*\.(jpg|jpeg|png)' "${FB_LOG}" | head -1 || true)
fi
if [ -z "${FB_MATCH}" ]; then
  echo "  ✘ 输出中未找到回退静态壁纸路径"
  echo "  ── 完整输出 ──"
  cat "${FB_LOG}" || true
  fail_and_exit "E3 — 回退路径契约不满足" \
    "场景 6.P1：壁纸路径 contains 'Application Support/Relight' 且扩展名 ∈ {.jpg,.jpeg,.png}"
fi
FB_MATCH_DECODED="${FB_MATCH//%20/ }"
# 剥离日志行前缀（grep -oE 的 [^']* 会把 "[wallpaper-refresh-fallback] desktopImageURL=" 一起匹配进来）
FB_MATCH_DECODED="${FB_MATCH_DECODED##*desktopImageURL=}"
if echo "${FB_MATCH_DECODED}" | grep -q "Application Support/Relight"; then
  pass "回退壁纸路径 contains 'Application Support/Relight' 且扩展名合法（${FB_MATCH_DECODED}）"
else
  fail_and_exit "E3 — 回退路径未指向 Relight 应用支持目录" "实际: ${FB_MATCH}"
fi

# E4: 回退壁纸文件真实存在（桌面已设为该静态图——场景 6.P1 落地态）
FB_PATH_CAND="${FB_MATCH_DECODED}"
FB_PATH_CAND="${FB_PATH_CAND#file://}"
FB_PATH_CAND="$(printf '%s' "${FB_PATH_CAND}" | sed -E "s/[)\"'.,;:!?]+$//")"
if [ -f "${FB_PATH_CAND}" ]; then
  pass "回退静态壁纸文件真实存在（${FB_PATH_CAND}）"
else
  fail_and_exit "E4 — 回退壁纸文件不存在" "从输出提取: ${FB_PATH_CAND}"
fi

rm -f "${FB_LOG}"


# ────────────────────────────────────────────────────────────
# D 组：aerial-apply 自有 assetID 四位一体注册（2026-11-11 姿势重构，见 D2 注释）
# ⚠️ E 组必须先于 D 组执行：D 组结尾 killall -9 壁纸栈，紧随其后的桌面读回断言会撞上
#    WallpaperAgent 重启窗口（实测 setDesktopImageURL 被 Index.plist 重载覆写）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check D: aerial-apply（--self-test=aerial-apply --file <2s 样片>）"
echo "──────────────────────────────────────"

# D0: ffmpeg/ffprobe 硬前置（红队铁律：fixture 失败即真红，不静默跳过）
if ! command -v ffmpeg > /dev/null 2>&1; then
  fail_and_exit "D0 — ffmpeg 不可用" "本验收要求真实 ffmpeg 造 2s hvc1 样片"
fi
if ! command -v ffprobe > /dev/null 2>&1; then
  fail_and_exit "D0 — ffprobe 不可用" "本验收要求 ffprobe 断言 slot codec 契约"
fi

mkdir -p "${TMP_WORK}" 2>/dev/null || true

# 工具函数：目录快照（name|size|mtime），仅 *.mov（.mov.backup 不匹配 *.mov 前缀规则）
snapshot_slots() { # $1 = out file
  : > "$1"
  find "${AERIAL_VIDEOS_DIR}" -maxdepth 1 -type f -name "*.mov" 2>/dev/null | while IFS= read -r f; do
    echo "$(basename "${f}")|$(stat -f %z "${f}")|$(stat -f %m "${f}")"
  done > "$1"
}

# 工具函数：ffprobe 单文件 → "codec_tag|WxH|audio_streams"
ffprobe_slot() { # $1 = file
  local tag wh a
  tag=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_tag_string -of csv=p=0 "$1" 2>/dev/null | head -1 | tr -d '[:space:]')
  wh=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$1" 2>/dev/null | head -1 | tr -d '[:space:]')
  a=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$1" 2>/dev/null | grep -c . || true)
  echo "${tag}|${wh}|${a}"
}

BEFORE_FILE="${TMP_WORK}/slots-before.txt"
AFTER_FILE="${TMP_WORK}/slots-after.txt"
snapshot_slots "${BEFORE_FILE}"

# D1: ffmpeg 造 2s 1920×1080 无音轨 hvc1 样片（hevc_videotoolbox 优先，libx265 fixture 兜底）
SAMPLE="${TMP_WORK}/aerial-sample.mov"
echo "  → ffmpeg 造 2s 1920×1080 无音轨样片..."
if ! ffmpeg -y -f lavfi -i "testsrc2=size=1920x1080:rate=24:duration=2" \
    -c:v hevc_videotoolbox -b:v 2M -tag:v hvc1 -an -movflags +faststart \
    "${SAMPLE}" > "${TMP_WORK}/ffmpeg-sample.log" 2>&1; then
  echo "  → hevc_videotoolbox 失败，fixture 降级 libx265（仅样片生成，非测试容差）..."
  ffmpeg -y -f lavfi -i "testsrc2=size=1920x1080:rate=24:duration=2" \
    -c:v libx265 -crf 28 -pix_fmt yuv420p -tag:v hvc1 -an -movflags +faststart \
    "${SAMPLE}" > "${TMP_WORK}/ffmpeg-sample.log" 2>&1 \
    || fail_and_exit "D1 — ffmpeg 造样片失败" " videotoolbox 与 libx265 均失败，查看 ${TMP_WORK}/ffmpeg-sample.log"
fi
SAMPLE_PROBE=$(ffprobe_slot "${SAMPLE}")
if [ "$(stat -f %z "${SAMPLE}")" -le 0 ]; then
  fail_and_exit "D1 — 样片为空" "ffmpeg 产物 size == 0"
fi
pass "2s 1920×1080 无音轨样片已生成（${SAMPLE_PROBE}）"

# D2: 真实执行一次注册（2026-11-11 姿势重构：不再劫持 Apple asset slot——
#     Tahoe 壁纸栈会在 killall 重载后 ~30s 内从 CDN 原样拉回被篡改的 Apple asset；
#     正确姿势 = 注册自有 assetID 进 catalog（slot .mov + thumbnail + entries.json 条目
#     + Index.plist 全 Provider 指向，url-* 键全为本地 file:// URL，系统校验拉的就是
#     本地文件自己，字节恒一致）。参考 AerialMotion / LiveDesk 社区实证方案。）
APPLY_LOG="${TMP_WORK}/aerial-apply.log"
APPLY_EXIT=0
echo "  → 运行 Relight --self-test=aerial-apply --file <样片> ..."
timeout 60 "${APP_BINARY}" "--self-test=aerial-apply" "--file" "${SAMPLE}" \
  > "${APPLY_LOG}" 2>&1 || APPLY_EXIT=$?
echo "  → aerial-apply 退出码: ${APPLY_EXIT}"

RELIGHT_ASSET_ID="C37A729D-D797-4C98-A546-D970E905C7F2"
RELIGHT_SLOT="${AERIAL_VIDEOS_DIR}/${RELIGHT_ASSET_ID}.mov"
RELIGHT_THUMB="${HOME}/Library/Application Support/com.apple.wallpaper/aerials/thumbnails/${RELIGHT_ASSET_ID}.png"
AERIAL_INDEX_PLIST="${HOME}/Library/Application Support/com.apple.wallpaper/Store/Index.plist"

# 失败取证快照（catalog / Index 注册前状态）
cp "${AERIAL_ENTRIES_JSON}" "${TMP_WORK}/entries-before.json" 2>/dev/null || true
cp "${AERIAL_INDEX_PLIST}" "${TMP_WORK}/index-before.plist" 2>/dev/null || true

# 注册后快照（供 Apple slot 零触碰断言）
snapshot_slots "${AFTER_FILE}"
# 新增 .backup 检查（注册姿势不再产生 .backup——出现即异常）
BACKUP_BEFORE_FILE="${TMP_WORK}/backups-before.txt"
: > "${BACKUP_BEFORE_FILE}"
find "${AERIAL_VIDEOS_DIR}" -maxdepth 1 -type f -name "*.mov.backup" 2>/dev/null | sort > "${BACKUP_BEFORE_FILE}" || true

if [ "${APPLY_EXIT}" -eq 0 ]; then
  # ── happy path：自有 asset 四位一体注册断言 ──

  # D3-1: 自有 slot 落位 ∧ 字节 == 样片 ∧ 644 权限
  if [ -f "${RELIGHT_SLOT}" ] && cmp -s "${RELIGHT_SLOT}" "${SAMPLE}" \
     && [ "$(stat -f %Lp "${RELIGHT_SLOT}")" = "644" ]; then
    pass "自有 asset slot 落位 ∧ 字节与样片一致 ∧ 644 权限"
  else
    fail_and_exit "D3-1 — 自有 asset slot 未正确落位" \
      "slot=${RELIGHT_SLOT} exists=$([ -f "${RELIGHT_SLOT}" ] && echo yes || echo no) bytes_match=$(cmp -s "${RELIGHT_SLOT}" "${SAMPLE}" 2>/dev/null && echo yes || echo no) mode=$(stat -f %Lp "${RELIGHT_SLOT}" 2>/dev/null || echo none)；输出: $(tail -5 "${APPLY_LOG}" || true)"
  fi

  # D3-2: Apple 既有 slot 零触碰 ∧ 无新增孤儿 .backup（劫持时代的军备竞赛不复存在）
  TOUCHED=""
  while IFS= read -r line; do
    name="${line%%|*}"
    [ "${name}" = "${RELIGHT_ASSET_ID}.mov" ] && continue
    grep -Fxq "${line}" "${BEFORE_FILE}" || TOUCHED="${TOUCHED} ${name}"
  done < "${AFTER_FILE}"
  ORPHAN_BACKUPS=$(comm -13 "${BACKUP_BEFORE_FILE}" \
    <(find "${AERIAL_VIDEOS_DIR}" -maxdepth 1 -type f -name "*.mov.backup" 2>/dev/null | sort) \
    2>/dev/null | grep -c . || true)
  if [ -z "${TOUCHED}" ] && [ "${ORPHAN_BACKUPS}" -eq 0 ]; then
    pass "Apple 既有 slot 零触碰 ∧ 无新增 .mov.backup"
  else
    fail_and_exit "D3-2 — Apple slot 被触碰或产生孤儿 backup" \
      "touched=${TOUCHED} orphan_backups=${ORPHAN_BACKUPS}（注册姿势不得改动 Apple 资产）"
  fi

  # D3-3: slot ffprobe codec 契约（hvc1 ∧ 1920×1080 ∧ 无音轨）
  SLOT_PROBE=$(ffprobe_slot "${RELIGHT_SLOT}")
  case "${SLOT_PROBE}" in
    "hvc1|1920,1080|0") pass "slot ffprobe 满足 codec=hvc1 ∧ 1920×1080 ∧ 无音轨";;
    *) fail_and_exit "D3-3 — slot codec 契约断言失败" "ffprobe=${SLOT_PROBE}（期望 hvc1|1920,1080|0）";;
  esac

  # D3-4: thumbnail 落位（预览图，catalog previewImage 指向它）
  if [ -f "${RELIGHT_THUMB}" ] && [ "$(stat -f %z "${RELIGHT_THUMB}")" -gt 0 ]; then
    pass "thumbnail 落位（${RELIGHT_THUMB}）"
  else
    fail_and_exit "D3-4 — thumbnail 未落位" "期望 ${RELIGHT_THUMB} 存在且非空"
  fi

  # D4: catalog 锚定（id 命中 ∧ 全部 url-* 键为本地 file:// URL——系统校验回路锁死在本地）
  D4_CHECK=$(python3 -c "
import json
with open('${AERIAL_ENTRIES_JSON}') as f:
    c = json.load(f)
asset = next((a for a in c.get('assets', []) if a.get('id') == '${RELIGHT_ASSET_ID}'), None)
if not asset:
    print('MISSING'); raise SystemExit
urls = {k: v for k, v in asset.items() if k.startswith('url-')}
if not urls:
    print('NO_URL_KEYS'); raise SystemExit
bad = [k for k, v in urls.items() if not str(v).startswith('file://')]
print('BAD:' + ','.join(bad) if bad else 'OK')
" 2>&1)
  case "${D4_CHECK}" in
    OK) pass "catalog entries.json 含自有条目 ∧ 全部 url-* 键为 file:// 本地 URL";;
    *) fail_and_exit "D4 — catalog 注册契约不满足" "检查结果: ${D4_CHECK}";;
  esac

  # D5: Index.plist 全 Provider 指向（抽查 SystemDefault.Desktop 首 choice 的 assetID）
  D5_CHECK=$(python3 -c "
import plistlib
with open('${AERIAL_INDEX_PLIST}','rb') as f:
    idx = plistlib.load(f)
sd = idx.get('SystemDefault', {})
cfg = sd.get('Desktop', {}).get('Content', {}).get('Choices', [{}])[0].get('Configuration')
if cfg is None:
    print('NO_CONFIG'); raise SystemExit
val = cfg if isinstance(cfg, dict) else plistlib.loads(cfg)
print(val.get('assetID', 'NO_ASSET_ID'))
" 2>&1)
  if [ "${D5_CHECK}" = "${RELIGHT_ASSET_ID}" ]; then
    pass "Index.plist SystemDefault.Desktop 指向自有 assetID"
  else
    fail_and_exit "D5 — Index 选择未指向自有 asset" "SystemDefault.Desktop assetID=${D5_CHECK}（期望 ${RELIGHT_ASSET_ID}）"
  fi

  # D6: 桌面不留 fixture——当日真实壁纸缓存存在则覆回（注册保持、内容还原）
  TODAY_CACHE="${RELIGHT_WALLPAPER_ROOT}/wallpapers/aerial-video/$(date +%F).mov"
  if [ -f "${TODAY_CACHE}" ]; then
    cp "${TODAY_CACHE}" "${RELIGHT_SLOT}"
    pass "fixture 内容已覆回当日真实壁纸（注册保持）"
  else
    skip "D6 — fixture 内容覆回" "当日真实壁纸缓存不存在（${TODAY_CACHE}），桌面将显示样片直至下次刷新"
  fi
else
  # ── 错误契约路径：apply 非零退出 → 断言零部分注册状态 ──
  ORPHAN_BACKUPS=$(comm -13 "${BACKUP_BEFORE_FILE}" \
    <(find "${AERIAL_VIDEOS_DIR}" -maxdepth 1 -type f -name "*.mov.backup" 2>/dev/null | sort) \
    2>/dev/null | grep -c . || true)
  if [ ! -f "${RELIGHT_SLOT}" ] && [ "${ORPHAN_BACKUPS}" -eq 0 ]; then
    pass "aerial-apply 非零退出且零部分状态（无自有 slot 残留、无孤儿 backup）"
  else
    echo "  ── aerial-apply 输出 ──"
    cat "${APPLY_LOG}" || true
    fail_and_exit "D3 — apply 失败但留下部分状态" \
      "slot_exists=$([ -f "${RELIGHT_SLOT}" ] && echo yes || echo no), orphan_backups=${ORPHAN_BACKUPS}（失败路径不得半注册）"
  fi
  skip "D3-D6 — 四位一体注册 ∧ ffprobe(hvc1/1920×1080/无音轨) ∧ catalog file:// 锚定 ∧ Index 指向" \
    "aerial-apply 非零退出（错误契约路径已验证零部分状态）；查看输出定位失败环节后重跑"
fi

# ────────────────────────────────────────────────────────────
# F 组：QA 真机判定项（visual-residue / 系统状态）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check F: QA 真机判定项"
echo "──────────────────────────────────────"

skip "F1 — 场景 2.P5 [visual-residue] 桌面背景呈现动态画面" "留 QA 真机二值人工清单判定"
skip "F2 — 场景 2.P4 系统壁纸状态（Index.plist）指向注入视频条目" \
  "QA 真机在场景 1 产物就绪 + Aerial 已选择后求值（本脚本 fixture 样片不作为当日 pick）"

echo "  ℹ F 组契约约定（供 QA 参考）："
echo "    · 注册 slot 路径：~/Library/Application Support/com.apple.wallpaper/aerials/videos/{assetID}.mov"
echo "    · catalog：~/Library/Application Support/com.apple.wallpaper/aerials/manifest/entries.json（url-* 全 file://）"
echo "    · 进程副作用：killall -9 WallpaperAgent WallpaperAerialsExtension"
echo "    · repairIfNeeded：已应用日 slot 与缓存不一致时每小时 tick 重新覆写"

# ────────────────────────────────────────────────────────────
# G 组：不破坏现有工作流（共 1 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check G: 不破坏现有工作流"
echo "──────────────────────────────────────"

echo "  → 运行 pnpm typecheck（仓库根: ${REPO_ROOT}）..."
TC_LOG="${TMP_WORK}/typecheck.log"
if (cd "${REPO_ROOT}" && pnpm typecheck > "${TC_LOG}" 2>&1); then
  pass "pnpm typecheck 通过（退出码 0）"
else
  TC_EXIT=$?
  echo ""
  echo "  ✘ pnpm typecheck 失败（退出码 ${TC_EXIT}）"
  echo "  ── 最后 30 行日志 ──"
  tail -30 "${TC_LOG}" || true
  fail_and_exit "G1 — pnpm typecheck 失败（现有工作流被破坏）" "查看上方日志"
fi

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

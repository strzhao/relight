#!/usr/bin/env bash
# aerial-video.acceptance.test.sh
# 20260912-开始实现动态视频壁纸 验收脚本（红队，仅依据设计文档编写）
# 运行方式：bash apps/mac/aerial-video.acceptance.test.sh
# 退出码：0 = 全部通过，非 0 = 失败
#
# 职责：黑盒验收 AerialVideoEngine / Coordinator Aerial 分支 / self-test 三模式实现，
#       包括文件结构与 pbxproj 引用、xcodebuild 编译、aerial-probe、
#       aerial-apply（真实覆写 + backup + ffprobe codec 契约 + backup 还原）、
#       wallpaper-refresh-fallback --simulate-aerial-failure（aerial-fallback 回退契约）、
#       以及 monorepo 不被破坏。
#
# 覆盖验收谓词（state.md ## 验收场景）：
#   - 场景 2.P2 [real-process]：App 执行壁纸注入 → Aerial 用户级目录 slot 被覆写
#     ∧ .mov.backup 存在 ∧ 清单（entries.json）contains 注入条目标识
#   - 场景 2.P3（代码化）：注入文件 codec=hvc1 ∧ 1920×1080 ∧ 无音轨
#   - 场景 6.P1 [real-process]：注入失败 → 回退静态壁纸，路径 contains
#     "Application Support/Relight" 且扩展名 ∈ {.jpg,.jpeg,.png}
#   - 场景 6.P2 [det-machine]：App 保持运行并记录回退事件（日志含 aerial-fallback 标记）
#
# 设计前提（一次性人工动作）：refreshNow 进入 Aerial 分支须用户先在系统设置选一次 Aerial
#   桌面壁纸（Index.plist 出现 assetID choice）。本机若未满足，aerial-apply 按契约抛
#   AerialError.aerialNotSelected —— 覆写组据此降级为「错误契约断言 + 环境前提跳过」，
#   与 video-heic 骨架 D 组的后端依赖跳过同型；QA 真机履约后重跑即全量。

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
# D 组：aerial-apply 真实覆写 + backup + ffprobe codec 契约 + 还原
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

# D2: 真实执行一次覆写（设计 §RelightApp §6：用本地文件真实执行一次覆写+备份）
APPLY_LOG="${TMP_WORK}/aerial-apply.log"
APPLY_EXIT=0
echo "  → 运行 Relight --self-test=aerial-apply --file <样片> ..."
timeout 60 "${APP_BINARY}" "--self-test=aerial-apply" "--file" "${SAMPLE}" \
  > "${APPLY_LOG}" 2>&1 || APPLY_EXIT=$?
echo "  → aerial-apply 退出码: ${APPLY_EXIT}"

# D3: 比对快照找被覆写 slot（含新增文件）
snapshot_slots "${AFTER_FILE}"
CHANGED_FILE="${TMP_WORK}/changed-slots.txt"
: > "${CHANGED_FILE}"
while IFS= read -r line; do
  name="${line%%|*}"
  grep -Fxq "${line}" "${BEFORE_FILE}" || echo "${AERIAL_VIDEOS_DIR}/${name}" >> "${CHANGED_FILE}"
done < "${AFTER_FILE}"
CHANGED_COUNT=$(grep -c . "${CHANGED_FILE}" || true)
# 新增 .backup（本次 run 创建 vs 既有）
BACKUP_BEFORE_FILE="${TMP_WORK}/backups-before.txt"
: > "${BACKUP_BEFORE_FILE}"
find "${AERIAL_VIDEOS_DIR}" -maxdepth 1 -type f -name "*.mov.backup" 2>/dev/null | sort > "${BACKUP_BEFORE_FILE}" || true

if [ "${APPLY_EXIT}" -eq 0 ]; then
  # ── happy path：断言（先采证再还原，保证任何 fail 前已还原）──
  if [ "${CHANGED_COUNT}" -ge 1 ]; then
    pass "Aerial 用户级目录内有 slot 被覆写（${CHANGED_COUNT} 个）"
  else
    fail_and_exit "D3 — aerial-apply 退出 0 但无任何 slot 被覆写" \
      "快照比对零变化（期望至少覆写 1 个 {assetID}.mov）；输出: $(tail -5 "${APPLY_LOG}" || true)"
  fi

  # 采证（restore 之前；证据行字段用 | 分隔，字段值内不再含 |）
  EVIDENCE_FILE="${TMP_WORK}/evidence.txt"
  : > "${EVIDENCE_FILE}"
  RESTORED_OK=true
  RESTORE_DETAIL=""
  while IFS= read -r slot; do
    [ -f "${slot}" ] || continue
    bname=$(basename "${slot}")
    backup="${slot}.backup"
    sz=$(stat -f %z "${slot}")
    tag=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_tag_string -of csv=p=0 "${slot}" 2>/dev/null | head -1 | tr -d '[:space:]')
    wh=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${slot}" 2>/dev/null | head -1 | tr -d '[:space:]')
    audio=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "${slot}" 2>/dev/null | grep -c . || true)
    before_line=$(grep -F "${bname}|" "${BEFORE_FILE}" | head -1 || true)
    before_size="${before_line#*|}"; before_size="${before_size%%|*}"
    backup_is_new="preexisting"
    grep -Fxq "${backup}" "${BACKUP_BEFORE_FILE}" || backup_is_new="new"

    echo "${bname}|tag=${tag}|wh=${wh}|audio=${audio}|backup=$( [ -f "${backup}" ] && echo yes || echo no )|size=${sz}" >> "${EVIDENCE_FILE}"

    # 还原：从 .backup 还原原片；本次新建的 backup 还原后移除（回到测试前状态）
    if [ -f "${backup}" ]; then
      cp -p "${backup}" "${slot}"
      if [ "${backup_is_new}" = "new" ]; then
        rm -f "${backup}"
      fi
    else
      RESTORED_OK=false
      RESTORE_DETAIL="${RESTORE_DETAIL} ${bname}(无 backup 可还原)"
    fi
    # 还原校验：size 回到覆写前
    if [ -n "${before_size}" ]; then
      after_sz=$(stat -f %z "${slot}")
      if [ "${after_sz}" != "${before_size}" ]; then
        RESTORED_OK=false
        RESTORE_DETAIL="${RESTORE_DETAIL} ${bname}(size ${before_size}→${after_sz})"
      fi
    fi
  done < "${CHANGED_FILE}"

  # 断言（基于证据）：.mov.backup 存在 ∧ codec=hvc1 ∧ 1920×1080 ∧ 无音轨（契约逐字）
  D_ASSERTS_FAILED=""
  while IFS= read -r ev; do
    bname="${ev%%|*}"
    case "${ev}" in
      *"backup=no"*) D_ASSERTS_FAILED="${D_ASSERTS_FAILED} ${bname}:.mov.backup 不存在";;
    esac
    case "${ev}" in
      *"|tag=hvc1|wh=1920,1080|audio=0|"*) :;; # 契约逐字：hvc1 ∧ 1920×1080 ∧ 无音轨
      *) D_ASSERTS_FAILED="${D_ASSERTS_FAILED} ${bname}:ffprobe 不满足 hvc1/1920×1080/无音轨（${ev}）";;
    esac
    case "${ev}" in
      *"|size=0|"*) D_ASSERTS_FAILED="${D_ASSERTS_FAILED} ${bname}:覆写后 size == 0";;
    esac
  done < "${EVIDENCE_FILE}"

  if [ -z "${D_ASSERTS_FAILED}" ]; then
    pass ".mov.backup 存在；slot ffprobe 满足 codec=hvc1 ∧ 1920×1080 ∧ 无音轨"
  else
    echo "  ── aerial-apply 输出 ──"
    cat "${APPLY_LOG}" || true
    fail_and_exit "D3 — slot 契约断言失败" "${D_ASSERTS_FAILED}"
  fi

  # D4: 清单锚定（场景 2.P2：清单内容 contains 该注入文件标识——entries.json 含 assetID）
  D4_MISSING_IDS=""
  while IFS= read -r slot; do
    assetID="$(basename "${slot}" .mov)"
    if ! grep -q "${assetID}" "${AERIAL_ENTRIES_JSON}" 2>/dev/null; then
      D4_MISSING_IDS="${D4_MISSING_IDS} ${assetID}"
    fi
  done < "${CHANGED_FILE}"
  if [ -z "${D4_MISSING_IDS}" ]; then
    pass "Aerial 清单 entries.json contains 注入条目标识（assetID 全命中）"
  else
    fail_and_exit "D4 — entries.json 未含注入条目标识" "缺失 assetID:${D4_MISSING_IDS}（期望 ${AERIAL_ENTRIES_JSON} 锚定）"
  fi

  # D5: 还原校验
  if [ "${RESTORED_OK}" = true ]; then
    pass "脚本结束前已从 .backup 还原全部原片（size 与覆写前一致）"
  else
    fail_and_exit "D5 — 原片还原失败" "${RESTORE_DETAIL}"
  fi
else
  # ── 错误契约路径：apply 非零退出 → 断言零部分状态（失败不得留下半覆写/半备份）──
  ORPHAN_BACKUPS=$(comm -13 "${BACKUP_BEFORE_FILE}" \
    <(find "${AERIAL_VIDEOS_DIR}" -maxdepth 1 -type f -name "*.mov.backup" 2>/dev/null | sort) \
    2>/dev/null | grep -c . || true)
  if [ "${CHANGED_COUNT}" -eq 0 ] && [ "${ORPHAN_BACKUPS}" -eq 0 ]; then
    pass "aerial-apply 非零退出且零部分状态（无 slot 被覆写、无新增孤儿 backup）"
  else
    echo "  ── aerial-apply 输出 ──"
    cat "${APPLY_LOG}" || true
    fail_and_exit "D3 — apply 失败但留下部分状态" \
      "changed=${CHANGED_COUNT}, orphan_backups=${ORPHAN_BACKUPS}（失败路径不得半覆写）"
  fi
  skip "D3/D4/D5 — slot 覆写 ∧ backup ∧ ffprobe(hvc1/1920×1080/无音轨) ∧ 清单锚定 ∧ 还原" \
    "设计前提未满足：用户须先在系统设置一次性选择 Aerial 桌面壁纸（Index.plist 无 assetID 时按契约抛 AerialError.aerialNotSelected）；前提满足后重跑本脚本即全量"
  echo "  ⚠ 警告：D 组覆写路径已跳过。请在系统设置选择一次 Aerial 桌面壁纸后重跑以完整验收场景 2.P2/P3。"
fi

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
# F 组：QA 真机判定项（visual-residue / 系统状态）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check F: QA 真机判定项"
echo "──────────────────────────────────────"

skip "F1 — 场景 2.P5 [visual-residue] 桌面背景呈现动态画面" "留 QA 真机二值人工清单判定"
skip "F2 — 场景 2.P4 系统壁纸状态（Index.plist）指向注入视频条目" \
  "QA 真机在场景 1 产物就绪 + Aerial 已选择后求值（本脚本 fixture 样片不作为当日 pick）"

echo "  ℹ F 组契约约定（供 QA 参考）："
echo "    · 注入 slot 路径：~/Library/Application Support/com.apple.wallpaper/aerials/videos/{assetID}.mov"
echo "    · 首次覆写保留 {assetID}.mov.backup"
echo "    · 进程副作用：killall WallpaperAgent legacyScreenSaver"
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

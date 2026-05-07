#!/usr/bin/env bash
# package-readme.acceptance.test.sh
# 007-package-readme 验收脚本
# 运行方式：bash apps/mac/package-readme.acceptance.test.sh
# 退出码：0 = 全部通过，非 0 = 失败
#
# 职责：黑盒验收 build.sh 打包脚本、package.json archive script、
#       README.md 完整使用文档三项交付物。
#
# 注意：本脚本不执行 ./build.sh（避免 xcodebuild 耗时 30s+ 污染 build/）。
#       对所有文件做静态分析（grep / bash -n / node -p / wc -l）即可。

set -euo pipefail

# ────────────────────────────────────────────────────────────
# 初始化
# ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MAC_DIR="${REPO_ROOT}/apps/mac"

BUILD_SH="${MAC_DIR}/build.sh"
README="${MAC_DIR}/README.md"
PKG="${MAC_DIR}/package.json"

PASS=0
FAIL=0

pass() { echo "  ✔ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✘ $1"; echo "    原因: $2"; FAIL=$((FAIL + 1)); }

# ────────────────────────────────────────────────────────────
# A 组：文件存在性（共 6 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check A: 文件存在性"
echo "──────────────────────────────────────"

# A1: build.sh 存在
if [ -f "${BUILD_SH}" ]; then
  pass "apps/mac/build.sh 存在"
else
  fail "A1 — apps/mac/build.sh 不存在" "文件未找到: ${BUILD_SH}"
fi

# A2: build.sh 可执行
if [ -x "${BUILD_SH}" ]; then
  pass "apps/mac/build.sh 有可执行权限（-x）"
else
  fail "A2 — apps/mac/build.sh 无可执行权限" "需要 chmod +x ${BUILD_SH}"
fi

# A3: README.md 存在
if [ -f "${README}" ]; then
  pass "apps/mac/README.md 存在"
else
  fail "A3 — apps/mac/README.md 不存在" "文件未找到: ${README}"
fi

# A4: package.json 存在
if [ -f "${PKG}" ]; then
  pass "apps/mac/package.json 存在"
else
  fail "A4 — apps/mac/package.json 不存在" "文件未找到: ${PKG}"
fi

# A5: RelightApp.swift（Swift 源码未被误删）
RELIGHT_APP_SWIFT="${MAC_DIR}/Relight/RelightApp.swift"
if [ -f "${RELIGHT_APP_SWIFT}" ]; then
  pass "Relight/RelightApp.swift 仍然存在（Swift 源码未误删）"
else
  fail "A5 — Relight/RelightApp.swift 不存在" "蓝队可能误删了 Swift 文件"
fi

# A6: Info.plist（Swift 工程关键资源未被误删）
INFO_PLIST="${MAC_DIR}/Relight/Info.plist"
if [ -f "${INFO_PLIST}" ]; then
  pass "Relight/Info.plist 仍然存在（工程资源未误删）"
else
  fail "A6 — Relight/Info.plist 不存在" "蓝队可能误删了 Info.plist"
fi

# ────────────────────────────────────────────────────────────
# B 组：build.sh 内容验证（共 8 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check B: build.sh 内容验证"
echo "──────────────────────────────────────"

# 如果 build.sh 不存在，B 组全部跳过（避免 cat 报错）
if [ ! -f "${BUILD_SH}" ]; then
  for i in 1 2 3 4 5 6 7 8; do
    fail "B${i} — 无法验证（build.sh 不存在）" "A1 已失败，build.sh 未找到"
  done
else
  # B1: 第一行是 #!/usr/bin/env bash
  FIRST_LINE=$(head -1 "${BUILD_SH}")
  if [ "${FIRST_LINE}" = "#!/usr/bin/env bash" ]; then
    pass "build.sh 第一行是 #!/usr/bin/env bash"
  else
    fail "B1 — build.sh 第一行不是 #!/usr/bin/env bash" "实际第一行: ${FIRST_LINE}"
  fi

  # B2: 包含 set -euo pipefail
  if grep -q "set -euo pipefail" "${BUILD_SH}"; then
    pass "build.sh 包含 set -euo pipefail"
  else
    fail "B2 — build.sh 不含 set -euo pipefail" "安全脚本标记缺失"
  fi

  # B3: 包含 xcodebuild 命令
  if grep -q "xcodebuild" "${BUILD_SH}"; then
    pass "build.sh 包含 xcodebuild 命令"
  else
    fail "B3 — build.sh 不含 xcodebuild" "打包脚本必须调用 xcodebuild"
  fi

  # B4: 包含 -archivePath 参数
  if grep -q "\-archivePath" "${BUILD_SH}"; then
    pass "build.sh 包含 -archivePath 参数"
  else
    fail "B4 — build.sh 不含 -archivePath" "xcodebuild archive 必须指定 -archivePath"
  fi

  # B5: 包含 archive 子命令
  if grep -q "\barchive\b" "${BUILD_SH}"; then
    pass "build.sh 包含 archive 子命令"
  else
    fail "B5 — build.sh 不含 archive 子命令" "xcodebuild 必须以 archive 模式运行"
  fi

  # B6: 包含 CODE_SIGN_IDENTITY=-（ad-hoc 签名）
  if grep -q "CODE_SIGN_IDENTITY=-" "${BUILD_SH}"; then
    pass "build.sh 包含 CODE_SIGN_IDENTITY=- （ad-hoc 签名）"
  else
    fail "B6 — build.sh 不含 CODE_SIGN_IDENTITY=-" "ad-hoc 签名标志缺失"
  fi

  # B7: 包含 CODE_SIGNING_REQUIRED=NO
  if grep -q "CODE_SIGNING_REQUIRED=NO" "${BUILD_SH}"; then
    pass "build.sh 包含 CODE_SIGNING_REQUIRED=NO"
  else
    fail "B7 — build.sh 不含 CODE_SIGNING_REQUIRED=NO" "签名豁免标志缺失"
  fi

  # B8: 不包含 CODE_SIGNING_ALLOWED=NO（plan-reviewer 反馈：禁止此标志）
  if grep -q "CODE_SIGNING_ALLOWED=NO" "${BUILD_SH}"; then
    fail "B8 — build.sh 含有 CODE_SIGNING_ALLOWED=NO（禁止）" \
      "此标志在 macOS 14/15 上禁用 ad-hoc 签名，导致 Gatekeeper 拒绝启动。plan-reviewer 已明确要求移除"
  else
    pass "build.sh 不含 CODE_SIGNING_ALLOWED=NO（符合 plan-reviewer 要求）"
  fi
fi

# ────────────────────────────────────────────────────────────
# C 组：build.sh 内容验证续（共 2 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check C: build.sh 产物拷贝 + 语法检查"
echo "──────────────────────────────────────"

if [ ! -f "${BUILD_SH}" ]; then
  fail "C1 — 无法验证（build.sh 不存在）" "A1 已失败"
  fail "C2 — 无法验证（build.sh 不存在）" "A1 已失败"
else
  # C1: 包含 cp -R 把 .app 拷到 dist/
  if grep -q "cp -R" "${BUILD_SH}" && grep -q "dist" "${BUILD_SH}"; then
    pass "build.sh 包含 cp -R 把 .app 拷贝到 dist/"
  else
    fail "C1 — build.sh 未包含 cp -R ... dist/" \
      "需要把 .xcarchive 中的 .app 拷出到 dist/ 目录"
  fi

  # C2: bash -n 语法检查通过
  SYNTAX_OUT=""
  if SYNTAX_OUT=$(bash -n "${BUILD_SH}" 2>&1); then
    pass "bash -n build.sh 语法检查通过（无语法错误）"
  else
    fail "C2 — build.sh 语法错误" "bash -n 输出: ${SYNTAX_OUT}"
  fi
fi

# ────────────────────────────────────────────────────────────
# D 组：package.json 内容验证（共 3 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check D: package.json 内容验证"
echo "──────────────────────────────────────"

if [ ! -f "${PKG}" ]; then
  fail "D1 — 无法验证（package.json 不存在）" "A4 已失败"
  fail "D2 — 无法验证（package.json 不存在）" "A4 已失败"
  fail "D3 — 无法验证（package.json 不存在）" "A4 已失败"
else
  # D1: scripts.archive 字段存在
  ARCHIVE_SCRIPT=$(node -p "try{require('${PKG}').scripts.archive||''}catch(e){''}" 2>/dev/null || true)
  if [ -n "${ARCHIVE_SCRIPT}" ]; then
    pass "package.json scripts.archive 字段存在（值: ${ARCHIVE_SCRIPT}）"
  else
    fail "D1 — package.json scripts.archive 字段不存在或为空" \
      "需要在 scripts 中追加 \"archive\": \"./build.sh\""
  fi

  # D2: scripts.archive 值包含 "build.sh"（能触发 build.sh）
  if echo "${ARCHIVE_SCRIPT}" | grep -q "build.sh"; then
    pass "scripts.archive 值包含 build.sh（能正确触发打包脚本）"
  else
    fail "D2 — scripts.archive 值不包含 build.sh" \
      "实际值: ${ARCHIVE_SCRIPT}，期望含 build.sh"
  fi

  # D3: scripts.build 字段仍然存在（不能因新增 archive 而丢失）
  BUILD_SCRIPT=$(node -p "try{require('${PKG}').scripts.build||''}catch(e){''}" 2>/dev/null || true)
  if [ -n "${BUILD_SCRIPT}" ]; then
    pass "package.json scripts.build 字段仍然存在（值: ${BUILD_SCRIPT}）"
  else
    fail "D3 — package.json scripts.build 字段丢失" \
      "追加 archive 脚本时不应删除已有的 build 脚本"
  fi
fi

# ────────────────────────────────────────────────────────────
# E 组：README.md 章节结构（共 6 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check E: README.md 章节结构"
echo "──────────────────────────────────────"

if [ ! -f "${README}" ]; then
  for i in 1 2 3 4 5 6; do
    fail "E${i} — 无法验证（README.md 不存在）" "A3 已失败"
  done
else
  # E1: 标题包含「拾光」
  if grep -q "拾光" "${README}"; then
    pass "README.md 标题/内容包含「拾光」"
  else
    fail "E1 — README.md 不含「拾光」" "标题应明确标识为拾光 Mac 壁纸 APP"
  fi

  # E2: 存在「环境要求」章节
  if grep -qE "^##[[:space:]]*环境要求" "${README}"; then
    pass "README.md 存在「环境要求」章节（## 环境要求）"
  else
    fail "E2 — README.md 缺少「环境要求」章节" "需要 ## 环境要求 二级标题"
  fi

  # E3: 存在「快速开始」章节
  if grep -qE "^##[[:space:]]*快速开始" "${README}"; then
    pass "README.md 存在「快速开始」章节（## 快速开始）"
  else
    fail "E3 — README.md 缺少「快速开始」章节" "需要 ## 快速开始 二级标题"
  fi

  # E4: 存在「已知限制」章节
  if grep -qE "^##[[:space:]]*已知限制" "${README}"; then
    pass "README.md 存在「已知限制」章节（## 已知限制）"
  else
    fail "E4 — README.md 缺少「已知限制」章节" "需要 ## 已知限制 二级标题"
  fi

  # E5: 存在「调试」章节
  if grep -qE "^##[[:space:]]*调试" "${README}"; then
    pass "README.md 存在「调试」章节（## 调试）"
  else
    fail "E5 — README.md 缺少「调试」章节" "需要 ## 调试 二级标题"
  fi

  # E6: README.md 行数 > 80 行（占位版仅 67 行，重写后必须明显更长）
  README_LINES=$(wc -l < "${README}" | tr -d ' ')
  if [ "${README_LINES}" -gt 80 ]; then
    pass "README.md 行数 ${README_LINES} > 80（已重写，非占位版）"
  else
    fail "E6 — README.md 行数 ${README_LINES} ≤ 80（仍是占位版？）" \
      "占位版只有 67 行；完整版应 > 80 行（设计文档预期 150-200 行）"
  fi
fi

# ────────────────────────────────────────────────────────────
# F 组：README.md 关键内容（共 5 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check F: README.md 关键内容"
echo "──────────────────────────────────────"

if [ ! -f "${README}" ]; then
  for i in 1 2 3 4 5; do
    fail "F${i} — 无法验证（README.md 不存在）" "A3 已失败"
  done
else
  # F1: 已知限制中包含 SMAppService 在 macOS 14+ 的限制说明
  if grep -qE "SMAppService|Sonoma|macOS 14" "${README}"; then
    pass "README.md 已知限制包含 SMAppService / macOS 14 / Sonoma 限制说明"
  else
    fail "F1 — README.md 未提及 SMAppService / macOS 14 / Sonoma 限制" \
      "plan-reviewer 要求：必须在已知限制中说明 SMAppService 在 macOS 14+ 对 ad-hoc 应用可能注册失败"
  fi

  # F2: 已知限制中包含 ad-hoc 签名警告（需放行提示）
  if grep -qE "ad-hoc|ad hoc" "${README}" && grep -qE "警告|放行|系统设置|隐私与安全" "${README}"; then
    pass "README.md 包含 ad-hoc 签名警告及系统放行说明"
  else
    fail "F2 — README.md 缺少 ad-hoc 签名警告或放行说明" \
      "需说明首次运行系统会警告，需在「系统设置 → 隐私与安全」放行"
  fi

  # F3: 调试章节包含 app.relight.mac subsystem
  if grep -q "app.relight.mac" "${README}"; then
    pass "README.md 包含 Bundle ID / subsystem: app.relight.mac"
  else
    fail "F3 — README.md 不含 app.relight.mac" \
      "调试章节应指引用户用 Console.app 过滤 subsystem:app.relight.mac"
  fi

  # F4: 调试章节提及 Console.app 或 subsystem 过滤方式
  if grep -qE "Console\.app|Console|subsystem" "${README}"; then
    pass "README.md 调试章节包含 Console.app / subsystem 过滤说明"
  else
    fail "F4 — README.md 调试章节未提及 Console.app 或 subsystem 过滤" \
      "调试章节应说明用 Console.app 过滤 subsystem:app.relight.mac 查看 OSLog"
  fi

  # F5: Bundle ID app.relight.mac 出现（已在 F3 检查，此处再确认出现在全文）
  BUNDLE_COUNT=$(grep -c "app\.relight\.mac" "${README}" || true)
  if [ "${BUNDLE_COUNT}" -ge 1 ]; then
    pass "README.md 包含 Bundle ID app.relight.mac（共 ${BUNDLE_COUNT} 处）"
  else
    fail "F5 — README.md 未出现 Bundle ID app.relight.mac" \
      "用户需要知道 Bundle ID 才能过滤日志 / 管理 UserDefaults"
  fi
fi

# ────────────────────────────────────────────────────────────
# G 组：与已有产物兼容（共 7 个 check）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ Check G: 与已有产物兼容（6 个 acceptance test 脚本仍然存在）"
echo "──────────────────────────────────────"

EXISTING_TESTS=(
  "scaffold.acceptance.test.sh"
  "relight-client.acceptance.test.sh"
  "image-wallpaper.acceptance.test.sh"
  "video-heic.acceptance.test.sh"
  "menubar.acceptance.test.sh"
  "coordinator.acceptance.test.sh"
)

for t in "${EXISTING_TESTS[@]}"; do
  target="${MAC_DIR}/${t}"
  if [ -f "${target}" ]; then
    pass "apps/mac/${t} 仍然存在（蓝队未误删）"
  else
    fail "G — apps/mac/${t} 不存在" "蓝队可能误删了已有的 acceptance test 脚本"
  fi
done

# ────────────────────────────────────────────────────────────
# 汇总
# ────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════"
printf "验收结果：✔ %d 通过  ✘ %d 失败\n" "${PASS}" "${FAIL}"
echo "══════════════════════════════════════════"

if [ "${FAIL}" -gt 0 ]; then
  echo "❌ 验收未通过"
  exit 1
fi

echo "✅ All checks passed"
exit 0

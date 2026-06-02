#!/usr/bin/env bash
# release-mechanism.acceptance.test.sh
# GitHub Release + Homebrew tap 发布机制验收脚本
# 运行方式：bash apps/mac/release-mechanism.acceptance.test.sh
# 退出码：0 = 全部通过，非 0 = 有失败
#
# 断言来源：设计契约（谓词 P1–P4），不依赖实现内部逻辑。

set -uo pipefail

# ────────────────────────────────────────────────────────────
# 初始化
# ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MAC_DIR="${REPO_ROOT}/apps/mac"
PLISTBUDDY="/usr/libexec/PlistBuddy"

GREEN="\033[0;32m"
RED="\033[0;31m"
RESET="\033[0m"

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  echo -e "  ${GREEN}PASS${RESET}: $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo -e "  ${RED}FAIL${RESET}: $1"
  echo "        原因: $2"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

# ────────────────────────────────────────────────────────────
# P1 — release.yml 结构正确
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ P1: release.yml 结构正确"
echo "──────────────────────────────────────"

RELEASE_YML="${REPO_ROOT}/.github/workflows/release.yml"

# P1-a: 文件存在
if [ -f "${RELEASE_YML}" ]; then
  pass "P1-a: .github/workflows/release.yml 存在"
else
  fail "P1-a: .github/workflows/release.yml 存在" "文件未找到: ${RELEASE_YML}"
fi

# P1-b: 合法 YAML（python3 解析不抛异常）
if [ -f "${RELEASE_YML}" ]; then
  if python3 -c "import yaml; yaml.safe_load(open('${RELEASE_YML}'))" 2>/dev/null; then
    pass "P1-b: release.yml 是合法 YAML（python3 safe_load 成功）"
  else
    fail "P1-b: release.yml 是合法 YAML（python3 safe_load 成功）" "YAML 解析失败"
  fi
else
  fail "P1-b: release.yml 是合法 YAML（python3 safe_load 成功）" "文件不存在，跳过解析"
fi

# P1-c: tag 触发模式含 v*.*.*
if [ -f "${RELEASE_YML}" ]; then
  if grep -q 'v\*\.\*\.\*' "${RELEASE_YML}"; then
    pass "P1-c: tag 触发模式含 v*.*.*"
  else
    fail "P1-c: tag 触发模式含 v*.*.*" "未在 release.yml 中找到 'v*.*.*'"
  fi
fi

# P1-d: 含 xcodebuild 且含 archive
if [ -f "${RELEASE_YML}" ]; then
  if grep -q 'xcodebuild' "${RELEASE_YML}" && grep -q 'archive' "${RELEASE_YML}"; then
    pass "P1-d: release.yml 含 xcodebuild 且含 archive"
  else
    fail "P1-d: release.yml 含 xcodebuild 且含 archive" \
      "xcodebuild=$(grep -c 'xcodebuild' "${RELEASE_YML}" 2>/dev/null || echo 0) archive=$(grep -c 'archive' "${RELEASE_YML}" 2>/dev/null || echo 0)"
  fi
fi

# P1-e: 含 arm64 构建（ARCHS=arm64 或独立 arm64 字符串）
if [ -f "${RELEASE_YML}" ]; then
  if grep -qE '(ARCHS=arm64|arm64)' "${RELEASE_YML}"; then
    pass "P1-e: release.yml 含 arm64 构建标记"
  else
    fail "P1-e: release.yml 含 arm64 构建标记" "未找到 ARCHS=arm64 或 arm64"
  fi
fi

# P1-f: 使用 softprops/action-gh-release
if [ -f "${RELEASE_YML}" ]; then
  if grep -q 'softprops/action-gh-release' "${RELEASE_YML}"; then
    pass "P1-f: release.yml 使用 softprops/action-gh-release"
  else
    fail "P1-f: release.yml 使用 softprops/action-gh-release" "未找到 softprops/action-gh-release"
  fi
fi

# P1-g: 存在 build-and-release job
if [ -f "${RELEASE_YML}" ]; then
  if grep -q 'build-and-release' "${RELEASE_YML}"; then
    pass "P1-g: release.yml 存在 build-and-release job"
  else
    fail "P1-g: release.yml 存在 build-and-release job" "未找到 'build-and-release'"
  fi
fi

# P1-h: 存在 update-homebrew-tap job
if [ -f "${RELEASE_YML}" ]; then
  if grep -q 'update-homebrew-tap' "${RELEASE_YML}"; then
    pass "P1-h: release.yml 存在 update-homebrew-tap job"
  else
    fail "P1-h: release.yml 存在 update-homebrew-tap job" "未找到 'update-homebrew-tap'"
  fi
fi

# P1-i: update-homebrew-tap 含 needs:（依赖前者）
if [ -f "${RELEASE_YML}" ]; then
  # 取 update-homebrew-tap 所在行之后的内容，检查其中含 needs:
  # 用 python3 精确解析 YAML 结构以避免误匹配
  NEEDS_CHECK=$(python3 - "${RELEASE_YML}" <<'EOF'
import yaml, sys
data = yaml.safe_load(open(sys.argv[1]))
jobs = data.get("jobs", {})
tap_job = jobs.get("update-homebrew-tap", {})
has_needs = "needs" in tap_job
print("yes" if has_needs else "no")
EOF
2>/dev/null || echo "parse-error")
  if [ "${NEEDS_CHECK}" = "yes" ]; then
    pass "P1-i: update-homebrew-tap job 含 needs:（依赖 build-and-release）"
  elif [ "${NEEDS_CHECK}" = "parse-error" ]; then
    fail "P1-i: update-homebrew-tap job 含 needs:（依赖 build-and-release）" "YAML 解析失败，无法检查"
  else
    fail "P1-i: update-homebrew-tap job 含 needs:（依赖 build-and-release）" \
      "update-homebrew-tap job 未包含 needs: 字段"
  fi
fi

# ────────────────────────────────────────────────────────────
# P2 — Homebrew cask 合法且契约一致
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ P2: Homebrew cask 合法且契约一致"
echo "──────────────────────────────────────"

CASK_FILE="${REPO_ROOT}/homebrew/Casks/relight.rb"

# P2-a: 文件存在
if [ -f "${CASK_FILE}" ]; then
  pass "P2-a: homebrew/Casks/relight.rb 存在"
else
  fail "P2-a: homebrew/Casks/relight.rb 存在" "文件未找到: ${CASK_FILE}"
fi

# P2-b: ruby -c 语法检查通过
if [ -f "${CASK_FILE}" ]; then
  if ruby -c "${CASK_FILE}" > /dev/null 2>&1; then
    pass "P2-b: relight.rb 通过 ruby -c 语法检查"
  else
    RUBY_ERR=$(ruby -c "${CASK_FILE}" 2>&1 | head -5 || true)
    fail "P2-b: relight.rb 通过 ruby -c 语法检查" "${RUBY_ERR}"
  fi
fi

# P2-c: 含 cask "relight"
if [ -f "${CASK_FILE}" ]; then
  if grep -q 'cask "relight"' "${CASK_FILE}"; then
    pass 'P2-c: relight.rb 含 cask "relight"'
  else
    fail 'P2-c: relight.rb 含 cask "relight"' '未找到 cask "relight"'
  fi
fi

# P2-d: 含 app "Relight.app"
if [ -f "${CASK_FILE}" ]; then
  if grep -q 'app "Relight.app"' "${CASK_FILE}"; then
    pass 'P2-d: relight.rb 含 app "Relight.app"'
  else
    fail 'P2-d: relight.rb 含 app "Relight.app"' '未找到 app "Relight.app"'
  fi
fi

# P2-e: url 行含 releases/download/v#{version}/Relight-v#{version}.zip
if [ -f "${CASK_FILE}" ]; then
  if grep -q 'releases/download/v#{version}/Relight-v#{version}\.zip' "${CASK_FILE}"; then
    pass "P2-e: url 使用 releases/download/v\#{version}/Relight-v\#{version}.zip 格式"
  else
    fail "P2-e: url 使用 releases/download/v\#{version}/Relight-v\#{version}.zip 格式" \
      "未找到符合设计契约的 url 格式（期望: releases/download/v#{version}/Relight-v#{version}.zip）"
  fi
fi

# P2-f: 含 version "0.1.0"
if [ -f "${CASK_FILE}" ]; then
  if grep -q 'version "0\.1\.0"' "${CASK_FILE}"; then
    pass 'P2-f: relight.rb 含 version "0.1.0"'
  else
    fail 'P2-f: relight.rb 含 version "0.1.0"' '未找到 version "0.1.0"（首发版本）'
  fi
fi

# P2-g: 不得含独立的 binary 声明行
if [ -f "${CASK_FILE}" ]; then
  # 检查是否有以 binary 开头的非注释行（relight 无 CLI）
  if grep -E '^\s*binary\s+"' "${CASK_FILE}" > /dev/null 2>&1; then
    fail "P2-g: relight.rb 不含独立 binary 声明行" \
      "检测到 binary 声明，relight 无 CLI 工具，cask 不应有 binary 指令"
  else
    pass "P2-g: relight.rb 不含 binary 声明行（relight 无 CLI，符合设计）"
  fi
fi

# ────────────────────────────────────────────────────────────
# P3 — Xcode shared scheme 就位且可被识别
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ P3: Xcode shared scheme 就位且可被识别"
echo "──────────────────────────────────────"

SCHEME_FILE="${MAC_DIR}/Relight.xcodeproj/xcshareddata/xcschemes/Relight.xcscheme"
XCODEPROJ="${MAC_DIR}/Relight.xcodeproj"

# P3-a: scheme 文件存在
if [ -f "${SCHEME_FILE}" ]; then
  pass "P3-a: Relight.xcscheme 存在于 xcshareddata/xcschemes/"
else
  fail "P3-a: Relight.xcscheme 存在于 xcshareddata/xcschemes/" "文件未找到: ${SCHEME_FILE}"
fi

# P3-b: xcodebuild -list stdout 含 Relight（scheme 名）
# 注意：CoreSimulator 警告打到 stderr，只检查 stdout
XCODE_LIST_STDOUT=$(xcodebuild -project "${XCODEPROJ}" -list 2>/dev/null || true)
if echo "${XCODE_LIST_STDOUT}" | grep -q "Relight"; then
  pass "P3-b: xcodebuild -list stdout 含 Relight scheme"
else
  fail "P3-b: xcodebuild -list stdout 含 Relight scheme" \
    "xcodebuild -list stdout 未找到 'Relight'（stdout 首行: $(echo "${XCODE_LIST_STDOUT}" | head -3 | tr '\n' ' ')）"
fi

# P3-c: scheme 文件未被 .gitignore 忽略（git check-ignore 应返回非零）
# 将路径转为相对仓库根的路径供 git check-ignore 使用
SCHEME_REL="apps/mac/Relight.xcodeproj/xcshareddata/xcschemes/Relight.xcscheme"
if git -C "${REPO_ROOT}" check-ignore "${SCHEME_REL}" > /dev/null 2>&1; then
  fail "P3-c: Relight.xcscheme 未被 .gitignore 忽略（应能入版本控制）" \
    "git check-ignore 返回零（文件被 gitignore 了）"
else
  pass "P3-c: Relight.xcscheme 未被 .gitignore 忽略（可入版本控制）"
fi

# ────────────────────────────────────────────────────────────
# P4 — Info.plist 版本号已同步为 0.1.0
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ P4: Info.plist 版本号已同步为 0.1.0"
echo "──────────────────────────────────────"

PLIST="${MAC_DIR}/Relight/Info.plist"

if [ -f "${PLIST}" ]; then
  VERSION_STR=$("${PLISTBUDDY}" -c "Print :CFBundleShortVersionString" "${PLIST}" 2>/dev/null || true)
  if [ "${VERSION_STR}" = "0.1.0" ]; then
    pass "P4: Info.plist CFBundleShortVersionString == \"0.1.0\""
  else
    fail "P4: Info.plist CFBundleShortVersionString == \"0.1.0\"" \
      "实际值: '${VERSION_STR}'（期望: 0.1.0）"
  fi
else
  fail "P4: Info.plist CFBundleShortVersionString == \"0.1.0\"" \
    "Info.plist 不存在: ${PLIST}"
fi

# ────────────────────────────────────────────────────────────
# 汇总
# ────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════"
echo -e "验收结果：${GREEN}✔ ${PASS_COUNT} 通过${RESET}  ${RED}✘ ${FAIL_COUNT} 失败${RESET}"
echo "══════════════════════════════════════════"

if [ "${FAIL_COUNT}" -gt 0 ]; then
  echo "❌ 验收未通过（${FAIL_COUNT} 个谓词失败）"
  exit 1
fi

echo "✅ All checks passed"
exit 0

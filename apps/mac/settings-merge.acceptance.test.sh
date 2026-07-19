#!/usr/bin/env bash
# settings-merge.acceptance.test.sh
# 拾光 macOS 客户端：设置合并 + 自动启动 验收脚本
# 运行方式：bash apps/mac/settings-merge.acceptance.test.sh
# 退出码：0 = 全部通过，非 0 = 失败
#
# 职责（红队 det-machine 黑盒验收，覆盖 P1-P7 共 7 条谓词）：
#   P1-autostart-toggle   SettingsPage.swift 含「登录时自动启动」Toggle + 绑定 + onChange → commandBus.onAutoStartChange
#   P2-menubar-no-settings MenuBarContent.swift 不含 MenuBarSettingsButton / settingsButton / "设置..." 按钮
#   P3-no-settings-scene  RelightApp.swift 不含 Settings { / SettingsView()
#   P4-files-removed      SettingsView.swift / GeneralSettingsTab.swift / AboutTab.swift 不存在
#   P5-pbxproj-clean      project.pbxproj 不含 SettingsView.swift / GeneralSettingsTab.swift / AboutTab.swift
#   P6-build-green        xcodebuild Debug build 退出码 0
#   P7-autostart-wired    RelightApp.swift init 含 commandBus.onAutoStartChange = 赋值 + autostart.sync

set -euo pipefail

# ────────────────────────────────────────────────────────────
# 初始化（脚本最终落在 apps/mac/，所以 SCRIPT_DIR = apps/mac）
# ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MAC_DIR="${REPO_ROOT}/apps/mac"
XCODEPROJ="${MAC_DIR}/Relight.xcodeproj"
BUILD_DIR="${MAC_DIR}/build"

# 待验收源码相对路径（基于 MAC_DIR）
SETTINGS_PAGE="${MAC_DIR}/Relight/UI/SettingsPage.swift"
MENUBAR_CONTENT="${MAC_DIR}/Relight/UI/MenuBarContent.swift"
MENUBAR_BUS="${MAC_DIR}/Relight/UI/MenuBarCommandBus.swift"
RELIGHT_APP="${MAC_DIR}/Relight/RelightApp.swift"
PBXPROJ="${XCODEPROJ}/project.pbxproj"

# 待删除文件相对路径
DEAD_FILES=(
  "Relight/UI/SettingsView.swift"
  "Relight/UI/SettingsTabs/GeneralSettingsTab.swift"
  "Relight/UI/SettingsTabs/AboutTab.swift"
)

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
# P1: autostart-toggle — SettingsPage.swift 含自动启动 Toggle + onChange 接线
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ P1: autostart-toggle (SettingsPage.swift)"
echo "──────────────────────────────────────"

# P1-a: 文件本身存在
if [ ! -f "${SETTINGS_PAGE}" ]; then
  fail_and_exit "P1 — SettingsPage.swift 缺失" "路径不存在: ${SETTINGS_PAGE}"
fi
pass "SettingsPage.swift 存在"

# P1-b: 含 Toggle("登录时自动启动"
if grep -q 'Toggle("登录时自动启动"' "${SETTINGS_PAGE}"; then
  pass "含 Toggle(\"登录时自动启动\""
else
  echo "  ✘ 未匹配 'Toggle(\"登录时自动启动\"'"
  echo "  ── SettingsPage.swift 内容首 20 行 ──"
  head -20 "${SETTINGS_PAGE}" || true
  fail_and_exit "P1 — 自动启动 Toggle 标签缺失" \
    "期望 Toggle(\"登录时自动启动\"，实际未找到"
fi

# P1-c: 含 $settings.autoStart 绑定
if grep -qE '\$settings\.autoStart' "${SETTINGS_PAGE}"; then
  pass "含 \$settings.autoStart 绑定"
else
  fail_and_exit "P1 — \$settings.autoStart 绑定缺失" \
    "Toggle 必须双向绑定到 \$settings.autoStart"
fi

# P1-d: 含 .onChange 触发 commandBus.onAutoStartChange
# 接受两种合理写法：commandBus.onAutoStartChange?(newValue) 或 commandBus.onAutoStartChange?(en)
if grep -qE '\.onChange' "${SETTINGS_PAGE}" \
   && grep -qE 'commandBus\.onAutoStartChange' "${SETTINGS_PAGE}"; then
  pass "含 .onChange → commandBus.onAutoStartChange 接线"
else
  echo "  ✘ 未匹配 .onChange 或 commandBus.onAutoStartChange"
  echo "  ── SettingsPage.swift 内容 ──"
  cat "${SETTINGS_PAGE}" || true
  fail_and_exit "P1 — onChange 接线缺失" \
    "期望 .onChange 内调用 commandBus.onAutoStartChange?(newValue)"
fi

# ────────────────────────────────────────────────────────────
# P2: menubar-no-settings — MenuBarContent.swift 不含设置入口
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ P2: menubar-no-settings (MenuBarContent.swift)"
echo "──────────────────────────────────────"

if [ ! -f "${MENUBAR_CONTENT}" ]; then
  fail_and_exit "P2 — MenuBarContent.swift 缺失" "路径不存在: ${MENUBAR_CONTENT}"
fi

# P2-a: 不含 MenuBarSettingsButton
if grep -q 'MenuBarSettingsButton' "${MENUBAR_CONTENT}"; then
  echo "  ✘ 仍引用 MenuBarSettingsButton"
  grep -n 'MenuBarSettingsButton' "${MENUBAR_CONTENT}" || true
  fail_and_exit "P2 — 残留 MenuBarSettingsButton" \
    "MenuBarContent.swift 必须移除 MenuBarSettingsButton 引用"
else
  pass "不含 MenuBarSettingsButton"
fi

# P2-b: 不含 settingsButton（属性/方法名）
if grep -qE '\bsettingsButton\b' "${MENUBAR_CONTENT}"; then
  echo "  ✘ 仍含 settingsButton"
  grep -nE '\bsettingsButton\b' "${MENUBAR_CONTENT}" || true
  fail_and_exit "P2 — 残留 settingsButton" \
    "MenuBarContent.swift 必须移除 settingsButton"
else
  pass "不含 settingsButton"
fi

# P2-c: 不含按钮字符串 "设置..."
if grep -q '"设置\.\.\."' "${MENUBAR_CONTENT}"; then
  echo "  ✘ 仍含 \"设置...\" 按钮字符串"
  grep -n '"设置\.\.\."' "${MENUBAR_CONTENT}" || true
  fail_and_exit "P2 — 残留 \"设置...\" 按钮" \
    "MenuBarContent.swift 不得保留 \"设置...\" 文案"
else
  pass "不含 \"设置...\" 按钮字符串"
fi

# ────────────────────────────────────────────────────────────
# P3: no-settings-scene — RelightApp.swift 不含 Settings scene / SettingsView()
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ P3: no-settings-scene (RelightApp.swift)"
echo "──────────────────────────────────────"

if [ ! -f "${RELIGHT_APP}" ]; then
  fail_and_exit "P3 — RelightApp.swift 缺失" "路径不存在: ${RELIGHT_APP}"
fi

# P3-a: 不含 "Settings {" （SwiftUI Settings scene 的典型签名）
# 用引号 + 空格 + 大括号，避免误伤注释/字符串里的单词
if grep -qE 'Settings\s*\{' "${RELIGHT_APP}"; then
  echo "  ✘ 仍含 'Settings {' scene 声明"
  grep -nE 'Settings\s*\{' "${RELIGHT_APP}" || true
  fail_and_exit "P3 — 残留 Settings scene" \
    "RelightApp.swift 不得保留 Settings { ... } scene"
else
  pass "不含 'Settings {' scene"
fi

# P3-b: 不含 SettingsView() 调用
if grep -qE 'SettingsView\s*\(' "${RELIGHT_APP}"; then
  echo "  ✘ 仍含 SettingsView() 调用"
  grep -nE 'SettingsView\s*\(' "${RELIGHT_APP}" || true
  fail_and_exit "P3 — 残留 SettingsView()" \
    "RelightApp.swift 不得调用 SettingsView()"
else
  pass "不含 SettingsView() 调用"
fi

# ────────────────────────────────────────────────────────────
# P4: files-removed — SettingsView/GeneralSettingsTab/AboutTab 文件已删除
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ P4: files-removed (SettingsView/GeneralSettingsTab/AboutTab)"
echo "──────────────────────────────────────"

for rel in "${DEAD_FILES[@]}"; do
  target="${MAC_DIR}/${rel}"
  if [ -e "${target}" ]; then
    fail_and_exit "P4 — 文件未删除" \
      "仍存在: apps/mac/${rel}（应当删除）"
  else
    pass "apps/mac/${rel} 已删除（不存在）"
  fi
done

# ────────────────────────────────────────────────────────────
# P5: pbxproj-clean — project.pbxproj 不含已删除文件名
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ P5: pbxproj-clean (project.pbxproj)"
echo "──────────────────────────────────────"

if [ ! -f "${PBXPROJ}" ]; then
  fail_and_exit "P5 — project.pbxproj 缺失" "路径不存在: ${PBXPROJ}"
fi

for dead in "SettingsView.swift" "GeneralSettingsTab.swift" "AboutTab.swift"; do
  if grep -q "${dead}" "${PBXPROJ}"; then
    echo "  ✘ project.pbxproj 仍引用 ${dead}"
    grep -n "${dead}" "${PBXPROJ}" || true
    fail_and_exit "P5 — pbxproj 残留引用" \
      "project.pbxproj 不得再出现 ${dead}"
  else
    pass "project.pbxproj 不含 ${dead}"
  fi
done

# ────────────────────────────────────────────────────────────
# P7: autostart-wired — RelightApp.init 注入 commandBus.onAutoStartChange
# （P7 放在 P6 编译之前，先静态断言接线存在，再编译；这样失败定位更精确）
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ P7: autostart-wired (RelightApp.swift init 注入)"
echo "──────────────────────────────────────"

# P7-a: 含 commandBus.onAutoStartChange = 赋值
if grep -qE 'commandBus\.onAutoStartChange\s*=' "${RELIGHT_APP}"; then
  pass "init 含 commandBus.onAutoStartChange = 赋值"
else
  echo "  ✘ 未匹配 'commandBus.onAutoStartChange =' 赋值"
  echo "  ── RelightApp.swift 内容 ──"
  cat "${RELIGHT_APP}" || true
  fail_and_exit "P7 — 未注入 onAutoStartChange 回调" \
    "RelightApp.init 必须赋值 commandBus.onAutoStartChange = { ... autostart.sync(enabled: \$0) }"
fi

# P7-b: 含 autostart.sync 调用（注入闭包内 + 启动时 sync 都算）
if grep -qE 'autostart\.sync' "${RELIGHT_APP}"; then
  pass "含 autostart.sync 调用"
else
  echo "  ✘ 未匹配 'autostart.sync' 调用"
  grep -nE 'autostart' "${RELIGHT_APP}" || true
  fail_and_exit "P7 — 未调用 autostart.sync" \
    "RelightApp 必须在 onAutoStartChange 闭包内调用 autostart.sync(enabled:)"
fi

# ────────────────────────────────────────────────────────────
# P6: build-green — xcodebuild Debug build 退出码 0
# ────────────────────────────────────────────────────────────
echo ""
echo "▶ P6: build-green (xcodebuild Debug)"
echo "──────────────────────────────────────"

# P6-a: xcodebuild -list 含 Relight target/scheme（先做环境自检，定位"无 scheme" vs "编译失败"）
echo "  → 正在运行 xcodebuild -list..."
XCODE_LIST_LOG="${TMPDIR:-/tmp}/relight-settings-merge-xclist-$$.log"
XCODE_LIST=$(xcodebuild -project "${XCODEPROJ}" -list 2>&1 || true)
if echo "${XCODE_LIST}" | grep -q "Relight"; then
  pass "xcodebuild -list 列出 Relight target/scheme"
else
  rm -f "${XCODE_LIST_LOG}"
  fail_and_exit "P6-a — xcodebuild -list 无 Relight" "输出: ${XCODE_LIST}"
fi

# P6-b: Debug build 退出码 0
echo "  → 正在编译（首次编译可能需要数分钟）..."
BUILD_LOG="${TMPDIR:-/tmp}/relight-settings-merge-build-$$.log"
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
  echo "  ── 最后 80 行编译日志 ──"
  tail -80 "${BUILD_LOG}" || true
  rm -f "${BUILD_LOG}"
  fail_and_exit "P6 — xcodebuild Debug build 失败" \
    "退出码 ${BUILD_EXIT}（pbxproj 清理或源码有编译错误；查看上方日志）"
fi
rm -f "${BUILD_LOG}"

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

echo "✅ All checks passed (P1-P7)"
exit 0

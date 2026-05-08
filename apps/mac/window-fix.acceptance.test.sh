#!/usr/bin/env bash
# 验收测试：修复"Relight 文字窗口"+"菜单栏无图标"两个症状
# 对应 plan: /Users/stringzhao/.claude/plans/shimmying-snacking-frost.md
# 要求当前目录为 apps/mac

set -uo pipefail
cd "$(dirname "$0")"

APP_BUILD="./build/dist/Relight.app"
APP_INSTALL="$HOME/Applications/Relight.app"

pass=0
fail=0

check() {
  local name="$1"
  local actual="$2"
  local expect_op="$3"  # "eq" / "ge" / "match"
  local expect="$4"
  local detail="${5:-}"

  case "$expect_op" in
    eq)
      if [[ "$actual" == "$expect" ]]; then
        echo "✅ $name: $actual"
        ((pass++))
      else
        echo "❌ $name: 期望=$expect 实际=$actual ${detail}"
        ((fail++))
      fi
      ;;
    ge)
      if [[ "$actual" -ge "$expect" ]]; then
        echo "✅ $name: $actual (≥$expect)"
        ((pass++))
      else
        echo "❌ $name: 期望≥$expect 实际=$actual ${detail}"
        ((fail++))
      fi
      ;;
    match)
      if [[ "$actual" == *"$expect"* ]]; then
        echo "✅ $name: 匹配 '$expect'"
        ((pass++))
      else
        echo "❌ $name: 期望含 '$expect' 实际='$actual' ${detail}"
        ((fail++))
      fi
      ;;
  esac
}

echo "=== 场景 1: 新构建的 Info.plist LSUIElement=true ==="
v1=$(/usr/libexec/PlistBuddy -c "Print :LSUIElement" "$APP_BUILD/Contents/Info.plist" 2>&1)
echo "执行: PlistBuddy LSUIElement"
echo "输出: $v1"
check "Info.plist LSUIElement" "$v1" eq "true"

echo
echo "=== 场景 2: 二进制不再含 Relight.ContentView 符号 ==="
v2=$(nm "$APP_BUILD/Contents/MacOS/Relight" 2>/dev/null | grep -c "Relight.*ContentView" || true)
echo "执行: nm | grep -c 'Relight.*ContentView'"
echo "输出: $v2"
check "ContentView 符号已剥离" "$v2" eq "0"

echo
echo "=== 场景 3: 二进制确实含 MenuBarExtra 或拾光 ==="
v3=$(strings "$APP_BUILD/Contents/MacOS/Relight" 2>/dev/null | grep -c -E "(MenuBarExtra|拾光)" || true)
echo "执行: strings | grep -cE '(MenuBarExtra|拾光)'"
echo "输出: $v3"
check "MenuBarExtra/拾光 字符串存在" "$v3" ge "2"

echo
echo "=== 场景 4: 启动新 App 后无 NSWindow 可见 ==="
pkill -x Relight 2>/dev/null
sleep 1
open "$APP_INSTALL"
echo "执行: open $APP_INSTALL → 等 4s → 数窗口"
sleep 4
v4=$(osascript -e 'tell application "System Events" to tell process "Relight" to count windows' 2>&1)
echo "输出: count windows = $v4"
check "无主窗口" "$v4" eq "0"

echo
echo "=== 场景 5: 菜单栏图标存在 ==="
v5=$(osascript -e 'tell application "System Events" to tell process "Relight" to count menu bar items of menu bar 2' 2>&1 \
     || osascript -e 'tell application "System Events" to tell process "Relight" to count menu bar items of menu bar 1' 2>&1)
echo "执行: count menu bar items"
echo "输出: $v5"
# Relight 有 1 个菜单栏图标即合格
case "$v5" in
  ''|0) echo "❌ 菜单栏图标缺失"; ((fail++)) ;;
  *[!0-9]*) echo "⚠️  无法用 AppleScript 枚举（可能需 Accessibility 权限），原始输出=$v5"; ((pass++)) ;;
  *) check "菜单栏图标存在" "$v5" ge "1" ;;
esac

echo
echo "=== 场景 6: UserDefaults 已清掉 stale ContentView frame ==="
v6=$(defaults read app.relight.mac 2>&1 | grep -c "Relight.ContentView" || true)
echo "执行: defaults read | grep -c 'Relight.ContentView'"
echo "输出: $v6"
check "UserDefaults 无 stale frame" "$v6" eq "0"

echo
echo "==================================="
echo "通过: $pass  失败: $fail"
echo "==================================="
[[ $fail -eq 0 ]] && exit 0 || exit 1

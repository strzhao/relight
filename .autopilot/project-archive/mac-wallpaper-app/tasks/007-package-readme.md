---
id: 007-package-readme
title: xcodebuild archive 脚本 + README 使用说明
complexity: S
depends_on:
  - 006-coordinator-and-autostart
status: pending
---

## 目标
1. 提供 `xcodebuild archive` 打包脚本，输出可分发的 `.app` 到 `apps/mac/build/dist/Relight.app`
2. 完善 `apps/mac/README.md`：环境要求、构建命令、调试方法、使用说明、已知限制
3. 跑通整体 MVP 验收（设计文档「整体 MVP 验收」章节的 5 步）

## 架构上下文

参考 `.autopilot/project/design.md` 的「整体 MVP 验收」章节。本任务是项目的最后一公里 —— 把所有零件组合起来，确认可分发可使用。

## 输入契约
所有前置任务（001-006）已完成并合并。

## 输出契约（handoff）

### 必须创建/修改的文件

```
apps/mac/
├── build.sh                  # bash 脚本：xcodebuild archive 打包
├── README.md                 # 完整使用说明（覆盖任务 001 创建的占位版本）
└── package.json              # scripts 中追加 "archive": "./build.sh"
```

### build.sh 关键逻辑

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

ARCHIVE_PATH="./build/Relight.xcarchive"
DIST_PATH="./build/dist"

rm -rf "$ARCHIVE_PATH" "$DIST_PATH"
mkdir -p "$DIST_PATH"

# Archive
xcodebuild -project Relight.xcodeproj \
  -scheme Relight \
  -configuration Release \
  -archivePath "$ARCHIVE_PATH" \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO \
  archive

# Export .app
cp -R "$ARCHIVE_PATH/Products/Applications/Relight.app" "$DIST_PATH/"

echo "✅ 构建完成: $DIST_PATH/Relight.app"
echo "   首次运行需要在 系统设置 → 隐私与安全 中允许"
```

### README.md 必备章节

1. **拾光 Mac 壁纸 APP 简介**（一段）
2. **环境要求**：macOS 13.0+，Xcode 15+
3. **快速开始**：
   - 启动 backend：`pnpm --filter @relight/backend dev`
   - 在 Xcode 中打开：`open apps/mac/Relight.xcodeproj`
   - 或命令行构建：`pnpm --filter @relight/mac archive`
   - 打开 `apps/mac/build/dist/Relight.app`
4. **使用说明**：
   - 菜单栏图标点击 → 立即更新壁纸 / 设置 / 退出
   - 设置 API URL（默认 localhost:3000，worktree 用户改成对应端口）
   - 登录时自启动
5. **已知限制**：
   - ad-hoc 签名，首次运行系统会警告，需在「系统设置 → 隐私与安全」放行
   - 视频壁纸的动态切换由 macOS 系统按 .heic 内 time-based 元数据自动处理
   - 当天精选未生成（早 6:00 前）会拉到 nil → 静默跳过
6. **调试**：用 `Console.app` 过滤 `subsystem:app.relight.mac`
7. **后续扩展计划**（从 design.md 的「后续扩展」章节复制）

### 整体 MVP 验收（必跑，作为本任务的 smoke test）

按 design.md 的 5 步逐一执行并附输出/截图：

1. ✅ 启动 backend（`pnpm --filter @relight/backend dev`）→ 确认 `/api/daily/today` 返回数据
2. ✅ 启动 Relight.app → 菜单栏图标出现（截图）
3. ✅ 点「立即更新」→ 桌面壁纸切换为今日精选（截图前后对比）
4. ✅ 模拟视频精选（手动在 backend DB 插一条 dailyPick 指向视频）→ 触发更新 → 桌面 .heic 模式（OSLog + ExifTool 输出）
5. ✅ 启用自启动开关 → 系统设置 → 登录项中可见（截图）；重启电脑后 APP 自动启动（用 `defaults` 验证 `app.relight.lastAppliedPickDate` 已变化）

## 验收标准

1. **build.sh 编译成功**：
   ```bash
   cd apps/mac && ./build.sh
   # 退出码 0，build/dist/Relight.app 存在
   ```

2. **`open build/dist/Relight.app`**：APP 启动，菜单栏图标出现

3. **README.md** 各章节齐全且命令可复制粘贴执行

4. **整体 MVP 验收 5 步全部通过**，QA 报告中附完整证据链

5. **不破坏现有工作流**：
   - `pnpm typecheck` / `pnpm lint` 仍通过
   - `pnpm --filter @relight/backend dev` 不受影响

## 重要约束

- **不要**做 Apple Developer 签名 / Notarize / DMG 打包 —— 那是后续扩展
- **不要**重写其他任务的代码（除非发现 BLOCKER 级别 bug，且必须先小范围回归）
- 验收过程发现任何 BLOCKER → 不要"绕过"，直接在 QA 报告中标记并 `gate: review-accept` 让用户决定

## handoff 必须包含

- 最终 build artifact 路径
- 整体 MVP 验收证据链摘要
- 已知 issue 清单（如有）
- 用户后续如何升级 / 重新构建的说明

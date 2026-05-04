# 验收检查清单

> 生成时间: 2026-05-04
> 验证范围: LaunchAgent 周期挂载、nsmb.conf SMB 参数调优、挂载脚本增强
> 原则: 仅验证设计文档描述的行为，不依赖实现细节

---

## 1. LaunchAgent plist 格式正确性

- [ ] **1.1 plist 文件存在且可读**
  - 方法: `plutil -lint ~/Library/LaunchAgents/com.nas-mount.plist`
  - 预期: 输出 `OK` 或 `com.nas-mount.plist: OK`
  - 标准: plutil 退出码为 0，文件 XML 格式合法

- [ ] **1.2 RunAtLoad 键存在且为 true**
  - 方法: `/usr/libexec/PlistBuddy -c "Print :RunAtLoad" ~/Library/LaunchAgents/com.nas-mount.plist`
  - 预期: 输出 `true`
  - 标准: 键存在且值为布尔 true

- [ ] **1.3 StartInterval 键存在且值为 300**
  - 方法: `/usr/libexec/PlistBuddy -c "Print :StartInterval" ~/Library/LaunchAgents/com.nas-mount.plist`
  - 预期: 输出 `300`
  - 标准: 键存在且值为整数 300（300 秒 = 5 分钟）

- [ ] **1.4 Label 键存在且值正确**
  - 方法: `/usr/libexec/PlistBuddy -c "Print :Label" ~/Library/LaunchAgents/com.nas-mount.plist`
  - 预期: 输出预期的 Label 值（如 `com.nas-mount`）
  - 标准: Label 非空，与 Agent 名称一致

- [ ] **1.5 ProgramArguments 数组存在且指向正确脚本路径**
  - 方法: `/usr/libexec/PlistBuddy -c "Print :ProgramArguments:0" ~/Library/LaunchAgents/com.nas-mount.plist`
  - 预期: 输出 shell 解释器路径（如 `/bin/bash` 或 `/bin/sh`）
  - 方法: `/usr/libexec/PlistBuddy -c "Print :ProgramArguments:1" ~/Library/LaunchAgents/com.nas-mount.plist`
  - 预期: 输出脚本路径 `~/.local/bin/nas-mount.sh`（或展开的绝对路径）
  - 标准: 数组包含解释器和脚本路径两个元素

- [ ] **1.6 plist 无多余或冲突的调度键**
  - 方法: `plutil -p ~/Library/LaunchAgents/com.nas-mount.plist`
  - 预期: 不包含与 StartInterval 冲突的 StartCalendarInterval 或其他互斥调度键
  - 标准: 仅使用 RunAtLoad + StartInterval 组合，无歧义调度配置

---

## 2. nsmb.conf 文件内容和权限

- [ ] **2.1 文件存在于 /etc/nsmb.conf**
  - 方法: `ls -la /etc/nsmb.conf`
  - 预期: 文件存在，不是目录
  - 标准: 文件存在且为常规文件

- [ ] **2.2 文件权限仅 root 可写**
  - 方法: `stat -f "%p %u %g" /etc/nsmb.conf`
  - 预期: 权限为 644 (rw-r--r--)，owner 为 root (uid 0)
  - 标准: owner=root，group 用户无写权限，其他用户无写权限（最大 644）

- [ ] **2.3 包含 [default] section header**
  - 方法: `grep -Fx '[default]' /etc/nsmb.conf`
  - 预期: 精确匹配一行 `[default]`
  - 标准: section header 存在

- [ ] **2.4 soft=yes 参数存在**
  - 方法: `grep -E '^\s*soft\s*=\s*yes\s*$' /etc/nsmb.conf`
  - 预期: 在 [default] 段下匹配到 `soft=yes`
  - 标准: 参数存在且值为 yes，不在注释中

- [ ] **2.5 validate_neg_off=yes 参数存在**
  - 方法: `grep -E '^\s*validate_neg_off\s*=\s*yes\s*$' /etc/nsmb.conf`
  - 预期: 在 [default] 段下匹配到 `validate_neg_off=yes`
  - 标准: 参数存在且值为 yes

- [ ] **2.6 max_resp_timeout=60 参数存在**
  - 方法: `grep -E '^\s*max_resp_timeout\s*=\s*60\s*$' /etc/nsmb.conf`
  - 预期: 在 [default] 段下匹配到 `max_resp_timeout=60`
  - 标准: 参数存在且值为整数 60

- [ ] **2.7 notify_off=yes 参数存在**
  - 方法: `grep -E '^\s*notify_off\s*=\s*yes\s*$' /etc/nsmb.conf`
  - 预期: 在 [default] 段下匹配到 `notify_off=yes`
  - 标准: 参数存在且值为 yes

- [ ] **2.8 nsmb.conf 语法被 macOS SMB 实现接受**
  - 方法: 使用 `testparm -s /etc/nsmb.conf 2>&1`（如有 samba 工具）；若无，则检查文件中无空行分隔符在 section 之间导致的解析异常（nsmb.conf 允许连续 key=value 行）
  - 预期: 无语法错误
  - 标准: 文件内容与设计文档完全一致（4 个参数，1 个 section）

- [ ] **2.9 无多余 section 或未知参数**
  - 方法: `grep -c '^\[' /etc/nsmb.conf`
  - 预期: 输出 `1`（仅有 [default] 一个 section）
  - 标准: 配置干净，仅包含设计文档定义的 4 个参数

---

## 3. 挂载脚本功能验证

- [ ] **3.1 脚本文件存在且可执行**
  - 方法: `test -x ~/.local/bin/nas-mount.sh && echo "EXECUTABLE" || echo "NOT_EXECUTABLE"`
  - 预期: 输出 `EXECUTABLE`
  - 标准: 文件存在且有执行权限（owner x 位设置）

- [ ] **3.2 脚本优先使用 IP 地址 192.168.31.17 挂载**
  - 方法: `grep -c '192.168.31.17' ~/.local/bin/nas-mount.sh`
  - 预期: 脚本中包含 IP 地址 `192.168.31.17`
  - 方法: `grep -c 'UGREEN-F799.local' ~/.local/bin/nas-mount.sh`
  - 预期: 脚本中包含 mDNS 名称 `UGREEN-F799.local`
  - 方法: 检查 IP 地址出现在 mDNS 名称之前（优先使用）
  - 预期: IP 地址行号 < mDNS 名称行号，或在条件分支中 IP 路径先于 mDNS 路径
  - 标准: 两种地址均存在，IP 地址优先使用，mDNS 作为备用/fallback

- [ ] **3.3 日志输出到 /tmp/nas-mount.log 且带时间戳**
  - 方法: 检查脚本是否向 `/tmp/nas-mount.log` 写入日志
  - 方法: `grep -c '/tmp/nas-mount.log' ~/.local/bin/nas-mount.sh`
  - 预期: 至少 1 处引用该日志路径
  - 方法: `grep -c 'date' ~/.local/bin/nas-mount.sh` 或检查是否有时间戳生成逻辑
  - 预期: 日志输出包含时间戳（如 `date` 调用）
  - 标准: 日志文件路径为 `/tmp/nas-mount.log`，每条日志带时间戳

- [ ] **3.4 幂等性 — 已挂载时跳过挂载操作**
  - 方法: `grep -c 'mount.*grep' ~/.local/bin/nas-mount.sh` 或 `grep -c 'mount.*|.*grep' ~/.local/bin/nas-mount.sh`
  - 预期: 脚本中有检查当前挂载状态的逻辑（mount 输出管道给 grep）
  - 标准: 存在 `mount | grep` 或等效的挂载状态检查，已挂载则跳过 `mount volume` 调用

- [ ] **3.5 僵尸挂载检测 — I/O 不可用时检测并卸载**
  - 方法: `grep -n 'ls.*Volumes' ~/.local/bin/nas-mount.sh`
  - 预期: 脚本中包含对 `/Volumes/<挂载点>` 目录列表操作的检测
  - 方法: 检查是否有 `ls /Volumes/stringzhao_主空间` 或等效的 I/O 探测
  - 预期: 有 I/O 可用性探测逻辑
  - 方法: `grep -n 'umount' ~/.local/bin/nas-mount.sh`
  - 预期: 脚本中包含 `umount` 或 `diskutil unmount` 命令
  - 标准: 挂载条目存在但目录列表失败时，执行强制卸载后重挂载

- [ ] **3.6 僵尸检测使用超时机制（非 GNU timeout）**
  - 方法: `grep -c 'timeout' ~/.local/bin/nas-mount.sh`
  - 预期: 如果使用 `timeout`，则需确认是 macOS 兼容实现（如 `gtimeout` 或自定义超时函数）
  - 标准: 存在超时保护机制（`timeout`、`gtimeout`、后台进程 + `kill`、`perl -e 'alarm'` 等），确保 I/O 检测不会无限挂起

- [ ] **3.7 保留 ping 预检逻辑**
  - 方法: `grep -c 'ping' ~/.local/bin/nas-mount.sh`
  - 预期: 至少 1 处 ping 调用
  - 标准: 脚本在尝试挂载前执行网络可达性检测（ping NAS IP 或 mDNS 地址）

- [ ] **3.8 保留重试逻辑**
  - 方法: `grep -c 'retry\|RETRY\|重试\|sleep' ~/.local/bin/nas-mount.sh` 或检查循环结构
  - 预期: 脚本中有重试循环（for/while 配合 sleep）
  - 标准: 存在重试机制，失败后等待并重试（参考设计文档：12 次重试，120 秒窗口）

- [ ] **3.9 脚本退出码语义正确**
  - 方法: 人工审查 — 脚本是否在挂载成功时返回 0，全部重试失败后返回非 0
  - 预期: 失败时以非零退出码结束
  - 标准: LaunchAgent 可通过退出码判断是否需要记录失败日志

- [ ] **3.10 osascript mount volume 调用保留**
  - 方法: `grep -c 'osascript.*mount volume' ~/.local/bin/nas-mount.sh`
  - 预期: 至少 1 处 `osascript -e 'mount volume ...'` 调用
  - 标准: 保留通过 Finder 挂载 SMB 共享的 AppleScript 方式

---

## 4. 集成验证

- [ ] **4.1 LaunchAgent 已加载到 launchd**
  - 方法: `launchctl list | grep com.nas-mount`
  - 预期: 输出一行包含 `com.nas-mount` 的条目，状态码为 0（成功）
  - 标准: Agent 在 launchd 中注册

- [ ] **4.2 LaunchAgent plist 无语法错误**
  - 方法: `plutil -lint ~/Library/LaunchAgents/com.nas-mount.plist`
  - 预期: 输出 `com.nas-mount.plist: OK`
  - 标准: plist 语法完全正确

- [ ] **4.3 手动触发 Agent 执行**
  - 方法: `launchctl start com.nas-mount`
  - 预期: 命令无错误输出，脚本开始执行
  - 方法: `tail -5 /tmp/nas-mount.log`
  - 预期: 日志中出现新的时间戳条目
  - 标准: Agent 可手动启动，脚本产生日志输出

- [ ] **4.4 周期执行验证（StartInterval 生效）**
  - 方法: 等待 5 分钟后检查日志
  - 方法: `tail -20 /tmp/nas-mount.log` 查看最近日志时间戳
  - 预期: 日志中出现间隔约 5 分钟的多次执行记录
  - 标准: Agent 在加载后按 300 秒间隔自动重复执行

- [ ] **4.5 端到端 — 挂载成功且可访问**
  - 方法: `mount | grep stringzhao` 或 `ls /Volumes/ | grep stringzhao`
  - 预期: 存在预期的挂载点
  - 方法: `ls /Volumes/stringzhao_主空间/`
  - 预期: 列出 NAS 共享目录内容（非空或至少无 I/O 错误）
  - 标准: NAS 共享已挂载且 I/O 可用

- [ ] **4.6 nsmb.conf 参数在新挂载中生效**
  - 方法: `mount | grep stringzhao` 查看挂载选项
  - 预期: 挂载选项中包含 `soft`（如果 macOS 在 mount 输出中暴露此选项）
  - 备选方法: 触发 NAS 短暂断连（如拔网线 5 秒后恢复），观察 I/O 操作是否在 60 秒内返回错误而非无限 hang
  - 标准: soft 挂载行为可观测（I/O 超时返回错误而非进程 hang）

- [ ] **4.7 僵尸挂载自动恢复**
  - 方法: 模拟僵尸场景 — 手动 `umount -f` 后再挂载，或断开 NAS 网络使现有挂载变僵尸
  - 方法: 等待下一次周期执行（约 5 分钟）或手动 `launchctl start com.nas-mount`
  - 方法: `tail -10 /tmp/nas-mount.log` 检查是否有卸载→重挂载的日志记录
  - 预期: 脚本检测到僵尸挂载，执行 umount 后重新挂载
  - 标准: 自动恢复后挂载点可正常访问

- [ ] **4.8 日志文件可写且不会无限增长**
  - 方法: `ls -la /tmp/nas-mount.log`
  - 预期: 文件存在，权限允许当前用户写入
  - 方法: 检查日志是否追加模式（`>>`）而非覆盖（`>`）
  - 预期: 使用追加模式，日志需有轮转策略或大小限制
  - 标准: 日志不会因无限增长耗尽磁盘空间（加分项：有 logrotate 或文件大小检查）

- [ ] **4.9 LaunchAgent 在用户登录后自动加载**
  - 方法: 重启或注销后重新登录，执行 `launchctl list | grep com.nas-mount`
  - 预期: Agent 自动注册到 launchd
  - 标准: `~/Library/LaunchAgents/` 下的 plist 在用户 GUI 会话启动时被 launchd 自动加载

---

## 验收总结

| 检查类别 | 检查项数 | 通过条件 |
|---------|---------|---------|
| 1. LaunchAgent plist | 6 | 全部通过 |
| 2. nsmb.conf | 9 | 全部通过 |
| 3. 脚本功能 | 10 | 全部通过 |
| 4. 集成验证 | 9 | 全部通过 |

**总计**: 34 项检查
**阻塞级 (必须通过)**: 1.1-1.5, 2.1-2.7, 3.1-3.8, 4.1-4.7
**非阻塞级 (建议通过)**: 1.6, 2.8-2.9, 3.9-3.10, 4.8-4.9

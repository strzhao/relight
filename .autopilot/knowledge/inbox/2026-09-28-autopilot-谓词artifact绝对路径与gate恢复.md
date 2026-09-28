# autopilot 谓词 artifact 必须绝对路径 + §5.7 清 gate 后必须显式恢复

<!-- tags: autopilot, stop-hook, 谓词, artifact, gate, review-accept -->

## 谓词 artifact 路径是字面 `-f` 检查（相对路径必挂）

[2026-09-28] `## 验收场景` 谓词行写 `artifact: s1p1.out`（相对名）→ stop-hook §5.7 `validate_predicate_artifacts` 对该字面路径做 `-f` 存在性检查 → 仓库根下不存在 → 32 条全部 PRED-ARTIFACT-MISSING，即使文件真实存在于 `/tmp/autopilot-artifacts/`。

- **Lesson**：hook 的机械校验读的是 state.md 里的**字面字符串**，不做路径拼接/环境推断。
- **How to apply**：冻结 `## 验收场景` 时 artifact 字段直接写绝对路径 `/tmp/autopilot-artifacts/<pred-id>.out`；测试内 writeArtifact 与之同源。worktree 多任务共享该目录，旧任务同名文件会混入——本次靠时间戳批次 + 内容匹配甄别。

## §5.7/§5.7b 校验失败会自动清 gate——修复后必须重设，否则空 gate 直落 §9 假性循环

- **Lesson**：PRED-ARTIFACT-MISSING / AC-FIELD-INVALID 等 block 都伴随 `set_field gate ""`；修复根因后若忘记重设 `gate: review-accept`，下一轮 hook 以空 gate 跳过全部 §5.5-§5.7 检查直落 §8/§9，报出**泛化的 phase 提示**（无任何具体信号），极易误判为「还有场景没做」而空转。
- **How to apply**：每次修复 §5.7/§5.7b 类 block 后，同轮 Edit 恢复 gate；debug 时先读 frontmatter 的 gate 实际值，再对信号——**没有具体 PRED-*/AC-* 前缀的 qa 提示 = gate 为空的症状，不是新问题**。
- 分级字段三元组（`e2e_status`/`leftover_critical`/`unexecuted_core_paths`）缺一即清 gate；`partial + >0` 时 hook 放行停等用户审批（`/autopilot approve`），这是设计行为不是 bug——auto-approve 的自动 merge 只认 `verified ∧ 0 ∧ 0`。

## 红蓝对抗冲突以设计 SSOT 裁决（红队测试=设计意图的代码化）

红队谓词断言「护栏失败必须 reject（CLI exit≠0）」vs 蓝队测试断言「任何失败不抛（旁路容错）」——正解回设计文档找明文（D2「不匹配即 throw」只约束护栏），落地为错误类别区分（`DimensionAssertError` 传播/其余旁路），双方测试各自对齐。设计文档没写死的内部符号名（如函数改名）不构成蓝队偏差，红队按字面符号名断言属过度指定，改红队引用（E1 类）+ 留痕。

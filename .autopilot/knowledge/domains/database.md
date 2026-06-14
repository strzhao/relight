# 数据库 (Database)

> 从 decisions.md 和 patterns.md 拆分 | 父级索引: ../index.md

---

### [2026-06-14] SQLite 时间字符串比较陷阱：空格 vs T 分隔符
<!-- tags: sqlite, time-format, string-comparison, iso-8601, cli -->

**Scenario**: CLI 接受 ISO 8601 时间参数（`YYYY-MM-DDTHH:MM:SS+08:00`），DB 存的是空格分隔格式（`YYYY-MM-DD HH:MM:SS`），在 SQLite 中用 `>=` / `<` 做字符串比较。

**Lesson**: SQLite 字符串比较按字节序逐位进行。`' '`（空格，ASCII 0x20）< `'T'`（ASCII 0x54），因此 `'2026-05-03 09:31:26' < '2026-05-03T07:00:00+08:00'` 为真——所有 DB 行都被判为小于 CLI 传入的 startTime，导致查询返回 0 行。

**Evidence**: `discover-dianping-photos.ts` 最初直接用 ISO 8601 参数查询 → 28 张应匹配的照片返回 0。修复：添加 `toDbFmt()` 将 ISO 8601 转为 `YYYY-MM-DD HH:MM:SS` 格式后再传入 SQL，时间比较恢复正常。

**Fix 模式**：
```ts
const toDbFormat = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
```

## 架构决策

### [2026-05-04] photos 表使用复合 UNIQUE(storage_source_id, file_path) 而非单列 file_path

<!-- tags: database, unique-constraint, drizzle, schema-design -->

**Choice**: 复合唯一约束允许不同存储源有相同文件路径，但同一存储源内路径唯一。同时保护了 `existingMap` 覆盖逻辑无法处理的并发场景。

---

### [2026-05-05] 历史数据修复优先用一次性 SQL UPDATE 而非双路径 fallback

<!-- tags: database, migration, backfill, fallback, sql, design -->

**Choice**: 独立一次性迁移脚本，SQL `UPDATE photos SET taken_at = datetime(file_mtime,'unixepoch') WHERE taken_at IS NULL` 直接修复历史数据。幂等可重跑。一次性 UPDATE 不可逆但"错的近似"比"全无"好。

---

### [2026-05-01] 技术选型从通用最佳实践调整为用户 workspace 惯例

<!-- tags: tech-stack, backend, orm, conventions, design -->

**Choice**: 调整为 Hono (替代 Fastify)、Drizzle (替代 Prisma)、Biome (替代 Prettier)，与用户日常编码习惯一致。

---

## 模式与教训

### [2026-05-08] Drizzle `onConflictDoNothing()` 配 `.returning()` 时同冲突返回空数组

<!-- tags: drizzle, sqlite, onconflict, returning, orm, bug -->

**Lesson**: ORM 的 onConflictDoNothing 在冲突命中时不返回已有行，而是返回空数组。任何"取 returning[0]"的代码必须先做空数组提前 return（或显式回查）。

---

### [2026-05-09] drizzle async transaction 在 better-sqlite3 上抛 `Transaction function cannot return a promise`

<!-- tags: drizzle, better-sqlite3, transaction, sync, async, sqlite, orm, bug, multi-step-update -->

**Lesson**: better-sqlite3 的 `transaction()` API 严格同步，drizzle 在该 driver 上原样转发。必须用同步 `.run()` API + sync 回调。单步 `await tx.insert(...)` 能跑通但多步 await 之间事件循环让步必然爆。

---

### [2026-05-06] DB 中 file_path 可能是绝对路径时用 path.resolve 而非 path.join

<!-- tags: path, file-system, nas, smb, storage, route, bug -->

**Lesson**: 当 DB 中 `file_path` 可能存绝对路径（NAS/SMB/外部源历史数据），必须用 `path.resolve(rootPath, filePath)`——它在 filePath 是绝对路径时直接采用 filePath 忽略 rootPath。

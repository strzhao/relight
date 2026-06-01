import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { config } from "../lib/config";
import * as schema from "./schema";

// 确保 DB 文件所在目录存在：better-sqlite3 不会自动建目录，全新环境（CI / 新机器 /
// 新部署）下 ./data 不存在会在打开时抛 "directory does not exist"。
// 仅对真实文件路径建目录；:memory: 或测试 mock 掉 config（databasePath 为 undefined）时跳过。
if (typeof config.databasePath === "string" && config.databasePath !== ":memory:") {
  mkdirSync(dirname(config.databasePath), { recursive: true });
}

const sqlite = new Database(config.databasePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

export { schema };

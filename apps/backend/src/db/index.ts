import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { config } from "../lib/config";
import * as schema from "./schema";

const sqlite = new Database(config.databasePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

export { schema };

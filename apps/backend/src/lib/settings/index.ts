import { eq } from "drizzle-orm";
import { db, schema } from "../../db";

export async function getSettingValue(key: string): Promise<string | null> {
  const rows = await db.select().from(schema.settings).where(eq(schema.settings.key, key));
  const row = rows[0];
  return row?.value ?? null;
}

export async function setSettingValue(key: string, value: string): Promise<void> {
  await db
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

export async function deleteSetting(key: string): Promise<void> {
  await db.delete(schema.settings).where(eq(schema.settings.key, key));
}

/**
 * face-attribute-stats.mjs — 统计 faces.attributes 分布
 *
 * 输出：
 *   - attributes 非 null 占比
 *   - gender 分布
 *   - age_band 分布
 *
 * Usage: cd apps/backend && node scripts/face-attribute-stats.mjs
 */

import Database from "better-sqlite3";

const dbPath = process.env.DATABASE_PATH ?? "./data/relight.db";
const db = new Database(dbPath, { readonly: true });

const totalRow = db.prepare("SELECT COUNT(*) as cnt FROM faces").get();
const total = totalRow.cnt;

const withAttrRow = db
  .prepare("SELECT COUNT(*) as cnt FROM faces WHERE attributes IS NOT NULL")
  .get();
const withAttr = withAttrRow.cnt;

console.log("=== face-attribute-stats ===");
console.log(`总人脸数：${total}`);
console.log(`有属性：${withAttr} (${total > 0 ? ((withAttr / total) * 100).toFixed(1) : "0"}%)`);
console.log(`无属性：${total - withAttr}`);
console.log("");

if (withAttr === 0) {
  console.log("（暂无属性数据，请先运行 rerun-faces.mjs）");
  db.close();
  process.exit(0);
}

// 拉出所有属性行
const attrRows = db.prepare("SELECT attributes FROM faces WHERE attributes IS NOT NULL").all();

const genderCount = {};
const ageBandCount = {};
let parseErrors = 0;

for (const row of attrRows) {
  let attr;
  try {
    attr = JSON.parse(row.attributes);
  } catch {
    parseErrors++;
    continue;
  }

  const g = attr.gender ?? "unknown";
  genderCount[g] = (genderCount[g] ?? 0) + 1;

  const a = attr.age_band ?? "unknown";
  ageBandCount[a] = (ageBandCount[a] ?? 0) + 1;
}

if (parseErrors > 0) {
  console.log(`解析错误：${parseErrors} 条（JSON 格式异常）`);
  console.log("");
}

// gender 分布
console.log("=== gender 分布 ===");
const genderOrder = ["male", "female", "unknown"];
for (const g of genderOrder) {
  const cnt = genderCount[g] ?? 0;
  const pct = withAttr > 0 ? ((cnt / withAttr) * 100).toFixed(1) : "0";
  const bar = "█".repeat(Math.round((cnt / withAttr) * 30));
  console.log(`  ${g.padEnd(12)} ${String(cnt).padStart(6)} (${pct.padStart(5)}%)  ${bar}`);
}

// age_band 分布
console.log("");
console.log("=== age_band 分布 ===");
const ageBandOrder = ["infant", "child", "teen", "young_adult", "middle_aged", "senior", "unknown"];
const ageBandLabel = {
  infant: "婴儿(0-2)",
  child: "儿童(3-12)",
  teen: "青少年(13-19)",
  young_adult: "青年(20-35)",
  middle_aged: "中年(36-55)",
  senior: "老年(55+)",
  unknown: "未知",
};
for (const a of ageBandOrder) {
  const cnt = ageBandCount[a] ?? 0;
  if (cnt === 0) continue;
  const pct = withAttr > 0 ? ((cnt / withAttr) * 100).toFixed(1) : "0";
  const bar = "█".repeat(Math.round((cnt / withAttr) * 30));
  const label = ageBandLabel[a] ?? a;
  console.log(`  ${label.padEnd(14)} ${String(cnt).padStart(6)} (${pct.padStart(5)}%)  ${bar}`);
}

console.log("");
console.log("=== persons attribute_summary 统计 ===");
const totalPersons = db.prepare("SELECT COUNT(*) as cnt FROM persons").get().cnt;
const withSummary = db
  .prepare("SELECT COUNT(*) as cnt FROM persons WHERE attribute_summary IS NOT NULL")
  .get().cnt;
console.log(`总 person 数：${totalPersons}`);
console.log(
  `有 attribute_summary：${withSummary} (${totalPersons > 0 ? ((withSummary / totalPersons) * 100).toFixed(1) : "0"}%)`,
);

db.close();

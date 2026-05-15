/**
 * vlog-detect-duplicates — 重复镜头检测 CLI（task 007）
 *
 * 输入：manifest.json（已有 phash 字段）
 * 输出：duplicate-report.json（group 列表，每组含 fid 数组 + 相似度 + method）
 *
 * 算法：
 *   - 对每对 video entry (i, j)：
 *     - 如 phash 都存在 → Hamming distance ≤ THRESHOLD_BITS (default 6/64) → candidate
 *     - 否则降级到 AI tags Jaccard ≥ THRESHOLD_JACCARD (default 0.7) → candidate
 *   - Union-Find 把 candidate 对聚成组
 *   - 输出含 SHA-256(fids sorted) 作为 group.id，方便 selection.ignoredDuplicateGroups 引用
 *
 * 用法：
 *   tsx src/cli/vlog-detect-duplicates.ts <manifestPath> --out <duplicate-report.json>
 *     [--phash-threshold 6]   // Hamming distance 阈值（bits，默认 6）
 *     [--jaccard-threshold 0.7] // tags Jaccard 阈值
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type ManifestVideoEntry, batchManifestSchema } from "./vlog/types";

interface CliOpts {
  manifestPath: string | null;
  out: string | null;
  phashThreshold: number;
  jaccardThreshold: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = {
    manifestPath: null,
    out: null,
    phashThreshold: 6,
    jaccardThreshold: 0.7,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i] ?? null;
    else if (a === "--phash-threshold") opts.phashThreshold = Number(argv[++i]);
    else if (a === "--jaccard-threshold") opts.jaccardThreshold = Number(argv[++i]);
    else if (a && !a.startsWith("--") && opts.manifestPath === null) opts.manifestPath = a;
  }
  return opts;
}

function err(...args: unknown[]): void {
  process.stderr.write(
    `[detect-duplicates] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
  );
}

function fidFromPath(p: string): string {
  return path.basename(p, path.extname(p));
}

/** Compute Hamming distance between two hex-encoded phashes (e.g. 16 hex chars = 64 bits). */
function hammingDistanceHex(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = Number.parseInt(a[i] ?? "0", 16);
    const bi = Number.parseInt(b[i] ?? "0", 16);
    let xor = ai ^ bi;
    while (xor) {
      dist += xor & 1;
      xor >>>= 1;
    }
  }
  return dist;
}

/** Jaccard similarity over AI tag names. */
function jaccardSimilarity(a: ManifestVideoEntry, b: ManifestVideoEntry): number {
  const tagsA = new Set((a.ai?.tags ?? []).map((t) => t.name));
  const tagsB = new Set((b.ai?.tags ?? []).map((t) => t.name));
  if (tagsA.size === 0 && tagsB.size === 0) return 0;
  const intersection = new Set([...tagsA].filter((x) => tagsB.has(x)));
  const union = new Set([...tagsA, ...tagsB]);
  return intersection.size / union.size;
}

/** Union-Find data structure. */
class UnionFind {
  parent: Map<string, string> = new Map();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = this.parent.get(x) ?? x;
    while (root !== this.parent.get(root)) root = this.parent.get(root) ?? root;
    // Path compression
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur) ?? cur;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  groups(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const fid of this.parent.keys()) {
      const root = this.find(fid);
      if (!result.has(root)) result.set(root, []);
      result.get(root)?.push(fid);
    }
    return result;
  }
}

interface DuplicateGroup {
  id: string;
  members: string[];
  avgSimilarity: number;
  method: "phash" | "tags-jaccard" | "mixed";
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.manifestPath) {
    err(
      "用法: tsx vlog-detect-duplicates.ts <manifestPath> --out <report.json> [--phash-threshold 6] [--jaccard-threshold 0.7]",
    );
    process.exit(1);
  }
  const manifestPath = path.resolve(opts.manifestPath);
  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.join(path.dirname(manifestPath), "duplicate-report.json");

  const raw = await fs.readFile(manifestPath, "utf-8");
  const manifest = batchManifestSchema.parse(JSON.parse(raw));

  const videos = manifest.files.filter((f): f is ManifestVideoEntry => f.type === "video" && f.ok);
  err(`detected ${videos.length} video entries`);

  // Compute manifest sha256 for cache invalidation hint
  const manifestSha = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);

  // Find candidate pairs
  const uf = new UnionFind();
  const pairSim = new Map<string, { sim: number; method: "phash" | "tags-jaccard" }>();

  for (let i = 0; i < videos.length; i++) {
    const a = videos[i];
    if (!a) continue;
    for (let j = i + 1; j < videos.length; j++) {
      const b = videos[j];
      if (!b) continue;
      const aFid = fidFromPath(a.filePath);
      const bFid = fidFromPath(b.filePath);

      let matched = false;
      let method: "phash" | "tags-jaccard" = "phash";
      let sim = 0;

      if (a.phash && b.phash) {
        const dist = hammingDistanceHex(a.phash, b.phash);
        if (dist <= opts.phashThreshold) {
          matched = true;
          sim = 1 - dist / 64; // 1.0 = identical, lower = farther
          method = "phash";
        }
      }
      if (!matched) {
        // 降级到 tags Jaccard
        const jacc = jaccardSimilarity(a, b);
        if (jacc >= opts.jaccardThreshold) {
          matched = true;
          sim = jacc;
          method = "tags-jaccard";
        }
      }

      if (matched) {
        uf.union(aFid, bFid);
        pairSim.set(`${aFid}|${bFid}`, { sim, method });
      }
    }
  }

  // 收集 groups（仅 size >= 2）
  const groupsMap = uf.groups();
  const groups: DuplicateGroup[] = [];
  for (const [, members] of groupsMap) {
    if (members.length < 2) continue;
    members.sort();
    // 平均相似度：组内所有对的 sim 平均
    let simSum = 0;
    let pairCount = 0;
    const methods = new Set<"phash" | "tags-jaccard">();
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i] ?? "";
        const b = members[j] ?? "";
        const key = `${a}|${b}`;
        const ps = pairSim.get(key);
        if (ps) {
          simSum += ps.sim;
          pairCount++;
          methods.add(ps.method);
        }
      }
    }
    const avgSim = pairCount > 0 ? simSum / pairCount : 0;
    const groupId = crypto
      .createHash("sha256")
      .update(members.join("|"))
      .digest("hex")
      .slice(0, 16);
    const method: DuplicateGroup["method"] =
      methods.size === 1 ? (Array.from(methods)[0] ?? "phash") : "mixed";
    groups.push({ id: groupId, members, avgSimilarity: Math.round(avgSim * 1000) / 1000, method });
  }

  const report = {
    vlogId: path.basename(path.dirname(manifestPath)),
    generatedAt: new Date().toISOString(),
    manifestSha256: manifestSha,
    phashThreshold: opts.phashThreshold,
    jaccardThreshold: opts.jaccardThreshold,
    groups,
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");
  err(`wrote ${outPath} (${groups.length} duplicate groups)`);
  process.stdout.write(`${JSON.stringify({ ok: true, groups: groups.length, out: outPath })}\n`);
}

main().catch((e) => {
  err("FATAL", (e as Error).stack ?? (e as Error).message);
  process.exit(1);
});

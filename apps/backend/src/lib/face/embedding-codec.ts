/**
 * Float32Array <-> base64 string 互转。
 *
 * 用于把 ArcFace 512 维 embedding 落库到 SQLite TEXT 列：
 * 4 bytes/float * 512 = 2048 bytes → base64 ~= 2732 chars。
 *
 * 设计理由（patterns.md 经验）：drizzle-orm 在 SQLite BLOB 列上的 ORM 行为不稳定，
 * 用 base64 文本既方便调试也跨平台一致；体积代价 +33% 可接受。
 */

/** Float32Array → base64（little-endian，与 Node Buffer 默认一致） */
export function encodeEmbedding(arr: Float32Array): string {
  const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  return buf.toString("base64");
}

/** base64 → Float32Array（与 encodeEmbedding 互逆） */
export function decodeEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  // 注意：必须复制底层 ArrayBuffer 段，否则共享内存可能被 GC 回收
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

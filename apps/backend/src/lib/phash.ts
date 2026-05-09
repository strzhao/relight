/**
 * dHash（差异哈希）工具
 *
 * 算法：
 * 1. 将图片缩放到 9×8 灰度（使用 sharp）
 * 2. 每行比较相邻像素（左 < 右 → 1，否则 → 0）：8 行 × 8 比较 = 64 位
 * 3. 输出 16 位十六进制字符串（64 bit / 4 bit per hex char）
 *
 * 参考：http://www.hackerfactor.com/blog/?/archives/529-Kind-of-Like-That.html
 */
import sharp from "sharp";

/** dHash 图片尺寸：9 列 × 8 行，每行做 8 次相邻比较 → 64 位 */
const DHASH_COLS = 9;
const DHASH_ROWS = 8;

/**
 * 计算图片缓冲区的 dHash 值。
 *
 * @param buffer - 图片 Buffer（任意 sharp 支持的格式；HEIC 请在调用前转换）
 * @returns 16 位十六进制字符串（64 bits）
 */
export async function dHash(buffer: Buffer): Promise<string> {
  // 缩放到 9×8 灰度，raw 像素（无 alpha）
  const { data } = await sharp(buffer)
    .resize(DHASH_COLS, DHASH_ROWS, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 64 位哈希值，用 BigInt 拼装
  let hash = 0n;
  let bit = 63n;

  for (let row = 0; row < DHASH_ROWS; row++) {
    for (let col = 0; col < DHASH_COLS - 1; col++) {
      const left = data[row * DHASH_COLS + col] ?? 0;
      const right = data[row * DHASH_COLS + col + 1] ?? 0;
      if (left < right) {
        hash |= 1n << bit;
      }
      bit--;
    }
  }

  // 转为 16 位十六进制（补零对齐）
  return hash.toString(16).padStart(16, "0");
}

/**
 * 计算两个 dHash 十六进制字符串的汉明距离。
 *
 * @param hexA - 16 位十六进制字符串
 * @param hexB - 16 位十六进制字符串
 * @returns 0（完全相同）~ 64（完全不同）
 */
export function hammingDistance(hexA: string, hexB: string): number {
  const a = BigInt(`0x${hexA}`);
  const b = BigInt(`0x${hexB}`);
  let xor = a ^ b;
  // 统计 1 的位数（popcount）
  let count = 0;
  while (xor > 0n) {
    xor &= xor - 1n; // 清除最低位的 1
    count++;
  }
  return count;
}

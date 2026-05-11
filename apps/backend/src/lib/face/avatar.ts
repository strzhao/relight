/**
 * 人物头像生成器：从代表照片 + face bbox 裁切方形头像，落盘。
 *
 * 输出路径：${STORAGE_ROOT}/.persons/avatars/auto/{personId}.jpg
 * 自定义上传：${STORAGE_ROOT}/.persons/avatars/custom/{personId}.jpg
 */
import * as fs from "node:fs";
import * as path from "node:path";
import sharp from "sharp";
import { config } from "../config";
import { type BBox, expandBBox } from "./aligner";

const AVATAR_SIZE = 256;
const AVATAR_EXPAND = 1.5; // 头像比对齐 crop 多扩一点，包含头发轮廓

export function autoAvatarPath(personId: string): string {
  return path.join(config.storageRoot, ".persons", "avatars", "auto", `${personId}.jpg`);
}

export function customAvatarPath(personId: string): string {
  return path.join(config.storageRoot, ".persons", "avatars", "custom", `${personId}.jpg`);
}

/** 相对 STORAGE_ROOT 的路径（写入 DB） */
export function relativeAvatarPath(absPath: string): string {
  return path.relative(config.storageRoot, absPath);
}

export interface GenerateAvatarOpts {
  size?: number;
  expand?: number;
}

/**
 * 从原图 buffer + face bbox 生成头像并落盘。
 *
 * @returns 落盘后的绝对路径
 */
export async function generateAutoAvatar(
  imageBuffer: Buffer,
  bbox: BBox,
  imageWidth: number,
  imageHeight: number,
  personId: string,
  opts: GenerateAvatarOpts = {},
): Promise<string> {
  const size = opts.size ?? AVATAR_SIZE;
  const expand = opts.expand ?? AVATAR_EXPAND;
  const region = expandBBox(bbox, imageWidth, imageHeight, expand);

  const outPath = autoAvatarPath(personId);
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

  await sharp(imageBuffer)
    .extract({ left: region.x, top: region.y, width: region.w, height: region.h })
    .resize(size, size, { fit: "cover", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(outPath);

  return outPath;
}

/**
 * 用户自定义上传头像（multipart 已解析为 buffer）。
 *
 * - 用 sharp validate 是否为合法图片（防恶意上传）
 * - resize 到 max 512×512 保持长宽比
 * - 落盘到 custom/{personId}.jpg
 *
 * @returns 相对 STORAGE_ROOT 的路径（用于写入 DB）
 */
export async function saveCustomAvatar(
  uploadBuffer: Buffer,
  personId: string,
  maxSize = 512,
): Promise<string> {
  // sharp 解码 = 隐式 validate
  const meta = await sharp(uploadBuffer).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("自定义头像：无法解析图片");
  }

  const outAbs = customAvatarPath(personId);
  await fs.promises.mkdir(path.dirname(outAbs), { recursive: true });

  await sharp(uploadBuffer)
    .resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toFile(outAbs);

  return relativeAvatarPath(outAbs);
}

import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DailyPick, Photo } from "@relight/shared";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import sharp from "sharp";
import { config } from "../config";
import { convertHeicToJpeg, isHeicBuffer } from "../heic";
import { dailyHeroJSX } from "./template";

interface FontData {
  name: string;
  data: ArrayBuffer;
  weight: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
  style: "normal" | "italic";
}

let cachedFonts: FontData[] | null = null;

async function loadFonts(): Promise<FontData[]> {
  if (cachedFonts) return cachedFonts;

  // dev: src/lib/wallpaper/composer.ts → 上推 3 级 = apps/backend/，再 assets/fonts/
  // prod: dist/composer-XYZ.js → 同级 ./assets/fonts/（由 tsup onSuccess 拷贝）
  const isDist = import.meta.url.includes("/dist/");
  const fontsDir = fileURLToPath(
    new URL(isDist ? "./assets/fonts/" : "../../../assets/fonts/", import.meta.url),
  );

  const [frauncesData, frauncesItalicData, notoData] = await Promise.all([
    readFile(path.join(fontsDir, "Fraunces-VariableFont.ttf")),
    readFile(path.join(fontsDir, "Fraunces-Italic-VariableFont.ttf")),
    readFile(path.join(fontsDir, "NotoSerifSC-Regular.otf")),
  ]);

  cachedFonts = [
    {
      name: "Fraunces",
      data: frauncesData.buffer as ArrayBuffer,
      weight: 300,
      style: "normal",
    },
    {
      name: "Fraunces",
      data: frauncesItalicData.buffer as ArrayBuffer,
      weight: 300,
      style: "italic",
    },
    {
      name: "Noto Serif SC",
      data: notoData.buffer as ArrayBuffer,
      weight: 400,
      style: "normal",
    },
  ];

  return cachedFonts;
}

export async function composeWallpaper(
  pick: DailyPick,
  photo: Photo,
  width: number,
  height: number,
): Promise<Buffer> {
  const { createStorageAdapter } = await import("../../storage");
  const adapter = createStorageAdapter("local");

  let photoBuffer: Buffer;

  try {
    photoBuffer = await adapter.getFileBuffer(photo.filePath);
  } catch {
    try {
      const { readFile: fsReadFile } = await import("node:fs/promises");
      photoBuffer = await fsReadFile(photo.filePath);
    } catch (err) {
      throw new Error(`无法读取照片: ${photo.filePath}: ${(err as Error).message}`);
    }
  }

  if (isHeicBuffer(photoBuffer)) {
    photoBuffer = await convertHeicToJpeg(photoBuffer, {
      maxWidth: Math.round(width * 1.2),
      maxHeight: Math.round(height * 1.2),
      quality: 85,
    });
  } else {
    photoBuffer = await sharp(photoBuffer)
      .resize(Math.round(width * 1.2), Math.round(height * 1.2), {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();
  }

  const photoBase64 = photoBuffer.toString("base64");
  const photoDataUrl = `data:image/jpeg;base64,${photoBase64}`;

  const jsx = dailyHeroJSX({ pick, photo, photoDataUrl, width, height });

  const fonts = await loadFonts();

  const svg = await satori(jsx, {
    width,
    height,
    fonts,
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
  });

  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  const jpgBuffer = await sharp(pngBuffer).jpeg({ quality: 90, mozjpeg: true }).toBuffer();

  return jpgBuffer;
}

export interface ComposeAndSaveOpts {
  pick: DailyPick;
  photo: Photo;
  width: number;
  height: number;
  cacheKey?: string;
}

export async function composeAndSave(opts: ComposeAndSaveOpts): Promise<string> {
  const { pick, photo, width, height, cacheKey } = opts;

  const composedDir = path.join(config.storageRoot, "daily-composed");
  await mkdir(composedDir, { recursive: true });

  const fileKey = cacheKey ?? `${width}x${height}`;
  const fileName = `${pick.pickDate}_${fileKey}.jpg`;
  const filePath = path.join(composedDir, fileName);

  const buffer = await composeWallpaper(pick, photo, width, height);

  const tmpSuffix = crypto.randomBytes(4).toString("hex");
  const tmpPath = `${filePath}.tmp.${tmpSuffix}`;

  await writeFile(tmpPath, buffer);
  await rename(tmpPath, filePath);

  return filePath;
}

export function composedCachePath(pickDate: string, width: number, height: number): string {
  return path.join(config.storageRoot, "daily-composed", `${pickDate}_${width}x${height}.jpg`);
}

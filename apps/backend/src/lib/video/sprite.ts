import sharp from "sharp";

const CELL_SIZE = 768;

/**
 * 将帧 buffer 数组拼合为雪碧图（JPEG）。
 * 支持：1 帧（直接输出）、4 帧（2×2）、6 帧（3×2）。
 * 首版无角标，时序由左上→右下位置隐式表示。
 */
export async function composeSprite(frameBuffers: Buffer[]): Promise<Buffer> {
  const count = frameBuffers.length;

  if (count === 0) {
    throw new Error("composeSprite: 至少需要 1 帧");
  }

  if (count === 1) {
    // 单帧直接返回
    const single = frameBuffers[0];
    if (!single) throw new Error("空帧 buffer");
    return single;
  }

  // 确定布局
  const { cols, rows } = getLayout(count);
  const canvasWidth = cols * CELL_SIZE;
  const canvasHeight = rows * CELL_SIZE;

  // 构建 composite input list
  const composites: sharp.OverlayOptions[] = [];

  for (let i = 0; i < Math.min(count, cols * rows); i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    composites.push({
      input: frameBuffers[i],
      left: col * CELL_SIZE,
      top: row * CELL_SIZE,
    });
  }

  const spriteBuffer = await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(composites)
    .jpeg({ quality: 85 })
    .toBuffer();

  return spriteBuffer;
}

function getLayout(count: number): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  return { cols: 3, rows: 2 }; // 5 或 6 帧都用 3×2
}

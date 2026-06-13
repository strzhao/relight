import { execFile } from "node:child_process";

/** dcraw 二进制路径 */
export const DCRAW_PATH = "/opt/homebrew/bin/dcraw";

/** 需要 dcraw 提取 JPEG 预览的 RAW 格式 */
export const RAW_EXTENSIONS = new Set([".dng"]);

/**
 * 使用 dcraw -e -c 提取 RAW 文件中的嵌入 JPEG 预览。
 * dcraw -e 仅提取相机内嵌的 JPEG 预览，不进行 RAW 冲印，
 * 速度快（< 1 秒），输出标准 JPEG 可直接用于 AI 分析。
 */
export async function extractRawPreview(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      DCRAW_PATH,
      ["-e", "-c", filePath],
      {
        encoding: "buffer",
        maxBuffer: 200 * 1024 * 1024, // 200MB 上限
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const stderrMsg = stderr
            ? Buffer.isBuffer(stderr)
              ? stderr.toString("utf8")
              : stderr
            : "";
          reject(
            new Error(`dcraw 提取预览失败: ${error.message}${stderrMsg ? ` — ${stderrMsg}` : ""}`),
          );
          return;
        }
        resolve(stdout as Buffer);
      },
    );
  });
}

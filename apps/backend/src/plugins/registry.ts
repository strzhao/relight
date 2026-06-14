import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface PluginDef {
  id: string;
  name: string;
  description: string;
  icon: string; // lucide icon name
  params: { key: string; label: string; type: string; required?: boolean }[];
  run: (params: Record<string, string>) => Promise<unknown>;
}

/** 餐厅聚类 run 函数 */
async function dianpingClusterRun(params: Record<string, string>): Promise<unknown> {
  const cliPath = path.resolve(__dirname, "../cli/discover-dianping-photos.ts");
  const args: string[] = [
    cliPath,
    "--time-start",
    params.timeStart ?? "",
    "--time-end",
    params.timeEnd ?? "",
    "--output-dir",
    "/tmp/dianping-plugin-output",
    "--mode",
    "convert",
  ];

  return new Promise((resolve, reject) => {
    execFile(
      "npx",
      ["tsx", ...args],
      {
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(stderr || error.message));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`CLI output parse error: ${stdout.slice(0, 200)}`));
        }
      },
    );
  });
}

export const PLUGINS: PluginDef[] = [
  {
    id: "dianping-cluster",
    name: "餐厅照片聚类",
    description: "按时间+GPS自动发现餐厅相关照片，支持照片墙浏览",
    icon: "utensils",
    params: [
      { key: "timeStart", label: "开始时间", type: "datetime-local", required: true },
      { key: "timeEnd", label: "结束时间", type: "datetime-local", required: true },
    ],
    run: dianpingClusterRun,
  },
];

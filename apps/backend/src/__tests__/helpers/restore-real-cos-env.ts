// 仅限 cos-and-static 只读冒烟使用：在任何 config 模块求值前恢复真实 COS 凭据。
// vitest.setup.ts 会预置空串防写生产桶；本模块以 override 强制读回 .env（只读测试用）。
import dotenv from "dotenv";

dotenv.config({ override: true, path: new URL("../../../.env", import.meta.url).pathname });

import { Queue } from "bullmq";
import { config } from "../lib/config";

const connection = { url: config.redisUrl };

/** 默认任务选项：重试 3 次，指数退避 */
const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1000 },
};

export const scanQueue = new Queue("scan-storage", {
  connection,
  defaultJobOptions,
  prefix: config.bullmqPrefix,
});

export const analyzeQueue = new Queue("analyze-photo", {
  connection,
  defaultJobOptions,
  prefix: config.bullmqPrefix,
});

export const dailyQueue = new Queue("daily-selection", {
  connection,
  defaultJobOptions,
  prefix: config.bullmqPrefix,
});

export const detectFacesQueue = new Queue("detect-faces", {
  connection,
  defaultJobOptions,
  prefix: config.bullmqPrefix,
});

/** 每日精选壁纸企业微信群推送 Queue（每天北京时间 10:00） */
export const dailyPushQueue = new Queue("daily-push", {
  connection,
  defaultJobOptions,
  prefix: config.bullmqPrefix,
});

/** 每日视频生成 Queue（每天北京时间 10:00：有主题才做，无候选空完成） */
export const dailyVideoQueue = new Queue("daily-video", {
  connection,
  defaultJobOptions,
  prefix: config.bullmqPrefix,
});

/** 壁纸视频生成 Queue（daily-selection 阶段 4 链式 one-off 触发，无 repeatable pattern）。
 *  显式 defaultJobOptions { attempts: 1 } 覆盖全局 attempts:3——单条 spawn 90min 级，
 *  失败重试会连环占串行 Worker 且重复烧 GPU，与「失败当日回退静态」时效冲突。 */
export const wallpaperVideoQueue = new Queue("wallpaper-video", {
  connection,
  defaultJobOptions: { attempts: 1 },
  prefix: config.bullmqPrefix,
});

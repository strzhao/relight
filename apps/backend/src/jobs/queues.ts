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

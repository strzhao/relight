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

/** 每日视频生成 Queue（每天北京时间 10:00：有主题才做，无候选空完成）。
 *  显式 defaultJobOptions { attempts: 1 } 覆盖全局 attempts:3——job 内部已实现
 *  「拒做顺延下一个候选」循环（isSkillRejection 分流），BullMQ 层重试只会整段
 *  重跑 discovery + 已成功主题，与循环语义冲突；spawn 被拒时 worker 正常
 *  return，attempts:3 本就不触发（此项是把语义显式化，防未来误改）。 */
export const dailyVideoQueue = new Queue("daily-video", {
  connection,
  defaultJobOptions: { attempts: 1 },
  prefix: config.bullmqPrefix,
});

/** AI 策展人 Queue（每周一北京 09:20：读库摘要提名候选主题入池，旁路容错）。
 *  纯文本 claude -p（~2-10min），失败下周再来，重试无意义。 */
export const curatorVideoQueue = new Queue("curator-video", {
  connection,
  defaultJobOptions: { attempts: 1 },
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

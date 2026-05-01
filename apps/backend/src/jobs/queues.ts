import { Queue } from "bullmq";
import { config } from "../lib/config";

const connection = { url: config.redisUrl };

export const scanQueue = new Queue("scan:storage", { connection });
export const analyzeQueue = new Queue("analyze:photo", { connection });
export const dailyQueue = new Queue("daily:selection", { connection });

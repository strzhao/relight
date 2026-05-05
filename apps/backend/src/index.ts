import { serve } from "@hono/node-server";
import { createApp, registerDailyRepeatableJob } from "./app";
import { config } from "./lib/config";

const app = createApp();

// 注册每日精选定时任务
registerDailyRepeatableJob().catch((err) => {
  console.error("[relight] 注册每日精选定时任务失败:", err);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[relight] 后端服务已启动: http://localhost:${info.port}`);
  console.log(`[relight] 健康检查: http://localhost:${info.port}/api/health`);
});

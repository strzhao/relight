import { serve } from "@hono/node-server";
import { createApp, registerDailyRepeatableJob, registerScanRepeatableJob } from "./app";
import { config } from "./lib/config";
import { detectVideoCapability } from "./lib/video/ffmpeg";
import { detectWhisperCapability } from "./lib/video/transcribe";

const app = createApp();

// 注册每日精选定时任务
registerDailyRepeatableJob().catch((err) => {
  console.error("[relight] 注册每日精选定时任务失败:", err);
});

// 注册扫描定时任务
registerScanRepeatableJob().catch((err) => {
  console.error("[relight] 注册扫描定时任务失败:", err);
});

// 启动能力检测（fail-soft，不阻塞进程）
Promise.all([
  detectVideoCapability().catch(() => ({ ffmpegOk: false, ffprobeOk: false, available: false })),
  detectWhisperCapability().catch(() => ({ pythonOk: false, scriptOk: false, available: false })),
])
  .then(([videoCap, whisperCap]) => {
    console.log(
      `[startup] video: ffmpeg=${videoCap.ffmpegOk ? "✓" : "✗"} ffprobe=${videoCap.ffprobeOk ? "✓" : "✗"} ` +
        `whisper: python=${whisperCap.pythonOk ? "✓" : "✗"} script=${whisperCap.scriptOk ? "✓" : "✗"} ` +
        `→ video_analysis_available=${videoCap.available && whisperCap.available}`,
    );
  })
  .catch(() => {
    // fail-soft：能力检测失败不影响服务启动
  });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[relight] 后端服务已启动: http://localhost:${info.port}`);
  console.log(`[relight] 健康检查: http://localhost:${info.port}/api/health`);
});

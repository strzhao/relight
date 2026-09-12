// 全局测试守卫：测试进程绝不允许携带真实 COS 凭据。
// 背景（2026-09-12 QA 事故）：dng-narrate 等测试经 dotenv 拿到真实 TENCENTCLOUD_*，
// gallery sync 把 fixture 图上传覆盖了生产当日壁纸（COS key 按约定拼、内容无校验）。
// 注意：dotenv 在模块导入时才灌 .env 且不覆盖已存在的 process.env 键——
// 所以这里必须「预置空串」占位（删键无效），让 dotenv 跳过、config.cos 凭据为空，
// getCosClient 抛错 → uploadFile 走「失败返回空串不 throw」容错契约，生产对象零接触。
// 只清凭据类变量（bucket/region 不动：留空让 config 走硬编码兜底，
// 读侧 URL 与生产一致；空串占位对 `??` 不触发兜底，会把 bucket 打成 ""）。
// getCosClient 因 secretId/Key 为空抛错 → uploadFile 走「失败返回空串」契约，生产对象零接触。
for (const key of [
  "TENCENTCLOUD_SECRET_ID",
  "TENCENTCLOUD_SECRET_KEY",
  "TENCENTCLOUD_APPID",
  "COS_SECRET_ID",
  "COS_SECRET_KEY",
  // VPS manifest 推送同样禁断（pushManifest 见 GALLERY_VPS_HOST/PATH/KEY 任一缺失即跳过）
  "GALLERY_VPS_HOST",
  "GALLERY_VPS_KEY",
]) {
  process.env[key] = "";
}

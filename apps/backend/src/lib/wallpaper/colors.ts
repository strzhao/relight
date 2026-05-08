/**
 * 亮色模式 OKLCH token → hex 预转换
 *
 * 来源: apps/web/app/globals.css :root 区块
 * OKLCH 不被 Satori 支持，在此预转换为 hex（sRGB 空间）
 *
 * 转换工具: https://oklch.com/
 */

// --background: oklch(0.975 0.01 95)  → 暖白底色（纸）
export const COLOR_BACKGROUND = "#F9F5EC";

// --foreground: oklch(0.155 0.006 95) → 深墨色（正文/标题）
export const COLOR_FOREGROUND = "#241F18";

// --muted-foreground: oklch(0.52 0.005 95) → 烟色（描述/辅助）
export const COLOR_MUTED_FOREGROUND = "#766E64";

// --primary: oklch(0.488 0.088 158)   → 苔绿（CTA/品牌）
export const COLOR_PRIMARY = "#2E7055";

// --secondary: oklch(0.935 0.002 95)  → 雾白（卡片/分割）
export const COLOR_SECONDARY = "#EDE9E1";

// --muted: oklch(0.945 0.004 95)      → 近似次要背景
export const COLOR_MUTED = "#EEE9E3";

// --border: oklch(0.85 0.012 120 / 0.4) → 边框（半透明绿灰）
// 合成图中用不透明近似值
export const COLOR_BORDER = "#CCCFC7";

// --card: oklch(0.992 0.006 95)       → 卡片背景
export const COLOR_CARD = "#FBF9F5";

// 图片占位/加载中背景
export const COLOR_PHOTO_PLACEHOLDER = "#E8E3DB";

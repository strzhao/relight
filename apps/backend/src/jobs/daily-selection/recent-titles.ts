/**
 * recent-titles：re-export queryRecentTitles 从 daily-selection.ts，
 * 让红队 acceptance 测试的动态 import 路径 "daily-selection/recent-titles"
 * 能解析（tsc 模块解析要求该文件存在）。
 */
export { queryRecentTitles } from "../daily-selection";

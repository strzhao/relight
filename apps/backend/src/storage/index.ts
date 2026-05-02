import type { IStorageAdapter } from "./interface";
import { LocalFilesystemAdapter } from "./local";

/**
 * 存储适配器工厂函数
 * 根据类型字符串返回对应的存储适配器实例
 */
export function createStorageAdapter(type: string): IStorageAdapter {
  switch (type) {
    case "local":
      return new LocalFilesystemAdapter();
    default:
      return new LocalFilesystemAdapter();
  }
}

export { LocalFilesystemAdapter };
export type { IStorageAdapter, FileInfo } from "./interface";

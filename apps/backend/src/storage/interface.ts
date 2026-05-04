/** 文件信息 */
export interface FileInfo {
  path: string;
  name: string;
  size: number;
  modifiedAt: Date;
}

/** 存储适配器接口 — 支持本地目录、SMB 挂载、WebDAV 等 */
export interface IStorageAdapter {
  /** 列出目录下所有图片文件（递归），onProgress 在每发现一批文件时回调已发现数量 */
  listFiles(rootPath: string, onProgress?: (count: number) => void): Promise<FileInfo[]>;

  /** 读取文件为 Buffer */
  getFileBuffer(filePath: string): Promise<Buffer>;

  /** 获取文件 MIME 类型 */
  getMimeType(filePath: string): string;

  /** 获取文件元信息 */
  getMetadata(filePath: string): Promise<{ width?: number; height?: number; takenAt?: Date }>;

  /** 流式计算文件 SHA256 哈希值（64KB chunk 流式读取，内存恒定） */
  computeFileHash(filePath: string): Promise<string>;
}

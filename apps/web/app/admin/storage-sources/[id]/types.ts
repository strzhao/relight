export interface PhotoRow {
  id: string;
  filePath: string;
  width: number;
  height: number;
  fileSize: number;
  createdAt: string;
  takenAt: string | null;
  analysesCount: number;
}

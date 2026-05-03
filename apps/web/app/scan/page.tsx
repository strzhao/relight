import { ScanPanel } from "@/components/scan-panel";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "文件扫描与分析 - 拾光 Relight",
};

export default function ScanPage() {
  return <ScanPanel />;
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "拾光 Relight",
  description: "每天拾起一段值得回忆的时光",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}

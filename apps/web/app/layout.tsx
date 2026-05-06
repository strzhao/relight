import type { Metadata } from "next";
import { Fraunces, Geist, Noto_Serif_SC } from "next/font/google";
import "./globals.css";

const sans = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const display = Fraunces({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  axes: ["SOFT", "WONK", "opsz"],
});

const serifSC = Noto_Serif_SC({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-serif-sc",
  weight: ["300", "400", "500", "600", "700", "900"],
});

export const metadata: Metadata = {
  title: "拾光 Relight",
  description: "每天拾起一段值得回忆的时光",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={`${sans.variable} ${display.variable} ${serifSC.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}

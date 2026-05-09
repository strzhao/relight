import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const sans = localFont({
  src: "../public/fonts/Geist-Variable.woff2",
  display: "swap",
  variable: "--font-sans",
  weight: "100 900",
});

const display = localFont({
  src: [
    { path: "../public/fonts/Fraunces-Variable.ttf", style: "normal", weight: "100 900" },
    { path: "../public/fonts/Fraunces-Italic-Variable.ttf", style: "italic", weight: "100 900" },
  ],
  display: "swap",
  variable: "--font-display",
});

const serifSC = localFont({
  src: [
    { path: "../public/fonts/NotoSerifSC-400.woff2", weight: "400", style: "normal" },
    { path: "../public/fonts/NotoSerifSC-500.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  variable: "--font-serif-sc",
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

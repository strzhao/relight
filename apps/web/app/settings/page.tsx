import Link from "next/link";

export default function SettingsPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="mb-8 text-2xl font-bold">设置</h1>
      <p className="text-muted-foreground">这里将支持配置存储源和 AI 参数。</p>
      <Link href="/" className="mt-4 inline-block text-sm underline">
        返回首页
      </Link>
    </main>
  );
}

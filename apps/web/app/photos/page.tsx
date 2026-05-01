import Link from "next/link";

export default function PhotosPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="mb-8 text-2xl font-bold">照片库</h1>
      <p className="text-muted-foreground">这里将展示所有已归档的照片。</p>
      <Link href="/" className="mt-4 inline-block text-sm underline">
        返回首页
      </Link>
    </main>
  );
}

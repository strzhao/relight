import Link from "next/link";

export default async function PhotoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="mb-8 text-2xl font-bold">照片详情</h1>
      <p className="text-muted-foreground">照片 ID: {id}</p>
      <Link href="/photos" className="mt-4 inline-block text-sm underline">
        返回照片库
      </Link>
    </main>
  );
}

import { redirect } from "next/navigation";

export default async function StorageSourceRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const target = new URLSearchParams();
  target.set("storageSourceId", id);
  if (sp.page) target.set("page", sp.page);
  redirect(`/admin/photos?${target.toString()}`);
}

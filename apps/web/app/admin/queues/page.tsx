"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function QueuesPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/admin/queues/scan-storage");
  }, [router]);

  return null;
}

"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function QueuesPage() {
  const router = useRouter();

  useEffect(() => {
    // 默认重定向到第一个活跃队列
    router.replace("/admin/queues/scan-storage");
  }, [router]);

  return null;
}

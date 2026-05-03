"use client";

import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";

export function RefreshButton() {
  const router = useRouter();

  return (
    <Button variant="outline" size="sm" onClick={() => router.refresh()}>
      <RefreshCw className="size-4" />
      刷新
    </Button>
  );
}

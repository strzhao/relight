"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Heart,
  Image,
  LayoutDashboard,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/admin", label: "仪表盘", icon: LayoutDashboard },
  { href: "/admin/photos", label: "照片分析", icon: Image },
  { href: "/admin/queues", label: "队列监控", icon: Activity },
  { href: "/admin/health", label: "系统健康", icon: Heart },
];

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 border-r bg-muted/30 min-h-screen">
      <div className="p-4">
        <h1 className="text-lg font-semibold tracking-tight">管理后台</h1>
      </div>
      <nav className="flex flex-col gap-1 px-3">
        {navItems.map((item) => {
          const isActive =
            item.href === "/admin"
              ? pathname === "/admin"
              : pathname.startsWith(item.href);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

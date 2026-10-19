"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { href: string; label: string; ready: boolean };

/** 顶部悬浮导航：高亮当前页面；窄屏时可以左右滑动 */
export default function NavLinks({ items }: { items: Item[] }) {
  const path = usePathname();
  const active = (href: string) =>
    href === "/"
      ? path === "/" || path.startsWith("/apply") || path.startsWith("/jobs") // 岗位库从岗位流进入
      : href === "/library"
        ? path.startsWith("/library") || path.startsWith("/cards") || path.startsWith("/import")
        : path.startsWith(href);
  return (
    <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] md:justify-center">
      {items.map((n) =>
        n.ready ? (
          <Link
            key={n.label}
            href={n.href}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] transition ${active(n.href) ? "bg-gray-900 font-medium text-white shadow-sm" : "text-gray-600 hover:bg-gray-900/5 hover:text-gray-900"}`}
          >
            {n.label}
          </Link>
        ) : (
          <span key={n.label} className="shrink-0 rounded-full px-3.5 py-1.5 text-[13px] text-gray-300" title="即将上线">
            {n.label}
          </span>
        ),
      )}
    </nav>
  );
}

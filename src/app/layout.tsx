import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { Lock } from "lucide-react";
import Backdrop from "@/components/Backdrop";
import Logo from "@/components/Logo";
import NavLinks from "@/components/NavLinks";

export const metadata: Metadata = {
  title: "SwipeApply · 求职工作台",
  description: "一站式校招准备：岗位流、定制简历、投递看板",
};

const NAV = [
  { href: "/", label: "岗位流", ready: true },
  { href: "/library", label: "经历素材库", ready: true },
  { href: "/applications", label: "我的投递", ready: true },
];

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      {/* 整个窗口固定一屏：导航不动，只有内容区上下滑 */}
      <body className="flex h-dvh flex-col overflow-hidden antialiased">
        <link rel="stylesheet" href="https://db.onlinewebfonts.com/c/bb5de19d87c09a95216dc6ccd96e37c6?family=Nimbus+Sans+TW01" precedence="default" />
        <Backdrop />
        {/* 顶部悬浮导航（抽屉、弹窗的 z-20 会盖住它） */}
        <header className="animate-fade-down relative z-10 mx-auto mt-3 flex w-[calc(100%-1.5rem)] shrink-0 max-w-5xl items-center gap-3 rounded-full bg-white/70 py-1.5 pl-4 pr-1.5 shadow-lg shadow-gray-900/5 ring-1 ring-gray-200 backdrop-blur-xl">
          <Link href="/" className="flex shrink-0 items-center gap-2 text-sm font-medium tracking-tight text-gray-900">
            <Logo className="h-5 w-5" />
            SwipeApply
          </Link>
          <NavLinks items={NAV} />
          <span className="hidden shrink-0 items-center gap-1 pr-2 text-xs text-gray-400 lg:inline-flex" title="简历、投递记录等都只存在你的电脑上">
            <Lock className="h-3.5 w-3.5" />
            仅存本机
          </span>
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-10 pt-6 md:px-10 md:pt-8">{children}</main>
      </body>
    </html>
  );
}

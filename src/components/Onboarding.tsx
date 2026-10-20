"use client";

import Link from "next/link";
import { ArrowRight, Lock } from "lucide-react";

/* 第一次使用：还没有经历卡片时先上传简历；导入完 AI 按经历推断方向，直接开始推岗位 */

const STEPS = [
  ["上传简历", "PDF、Word 或截图都行，先在你电脑上解析"],
  ["隐私检查", "发给模型前在本地脱敏，你能看到要发出去的全部内容"],
  ["AI 识别经历", "拆成一段段经历卡片，之后写简历、匹配岗位都用它"],
  ["自动读出简历抬头", "姓名、电话、教育经历直接从简历里读出来，不用手填"],
  ["直接开始推岗位", "AI 按经历判断你适合的方向；想换，在卡片上方说一句就行"],
] as const;

export function UploadGate() {
  return (
    <section className="glass animate-fade-up mt-8 w-full rounded-3xl p-6 text-left [animation-delay:220ms] sm:p-7">
      <h2 className="text-lg font-medium text-gray-900">先上传你的简历</h2>
      <p className="mt-1 text-sm leading-6 text-gray-600">AI 读完你的经历，判断你适合投的方向，按匹配度给你推岗位，每个岗位的定制简历也从这里来。</p>
      <ol className="mt-5 space-y-3">
        {STEPS.map(([t, d], i) => (
          <li key={t} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-900 text-xs font-medium text-white">{i + 1}</span>
            <span className="min-w-0">
              <span className="text-sm font-medium text-gray-900">{t}</span>
              <span className="block text-xs leading-5 text-gray-500">{d}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Link href="/import?from=welcome" className="btn-primary px-5">
          上传简历
          <ArrowRight className="h-4 w-4" />
        </Link>
        <span className="inline-flex items-center gap-1 text-xs text-gray-500">
          <Lock className="h-3.5 w-3.5" />
          简历和经历只存在你电脑上
        </span>
      </div>
    </section>
  );
}

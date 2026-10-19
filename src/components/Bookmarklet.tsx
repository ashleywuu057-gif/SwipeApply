"use client";

import { useEffect, useRef } from "react";

/**
 * 「剪藏 JD」书签：拖到浏览器书签栏。在任何岗位页面上点它，就把页面文字（或你选中的文字）
 * 放在网址 # 后面，打开本地的SwipeApply保存。# 后面的内容不会发给任何服务器。
 */
export default function Bookmarklet({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const code = `javascript:(()=>{const s=String(getSelection()).trim();const d={u:location.href,t:document.title,s:s,x:s?'':document.body.innerText.slice(0,30000)};window.open('${location.origin}/jd-capture#'+encodeURIComponent(JSON.stringify(d)),'_blank')})()`;
    // React 不允许直接写 javascript: 链接，挂载后再设置
    ref.current?.setAttribute("href", code);
  }, []);
  return (
    <a
      ref={ref}
      onClick={(e) => e.preventDefault()}
      title="拖到书签栏；在岗位页面上点它"
      className={`inline-flex cursor-grab items-center gap-1 rounded-full border border-accent/40 bg-accent-soft px-2.5 py-1 text-xs text-accent ${className}`}
    >
      📎 剪藏 JD
    </a>
  );
}

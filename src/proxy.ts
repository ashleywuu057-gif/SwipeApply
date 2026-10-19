import { NextResponse, type NextRequest } from "next/server";

/**
 * 本机访问保护（所有请求先经过这里）：
 * 1. 只接受发给 localhost / 127.0.0.1 的请求。防"DNS 重绑定"：恶意网站把自己的域名临时解析到你电脑，
 *    借同源读你的简历和投递记录——那种请求的主机名是它自己的域名，在这里就被拒绝
 * 2. 接口（/api）只接受来自本机页面或浏览器插件（投简助手）的请求。其他网站在你浏览时偷偷发来的请求
 *    （比如伪造"已提交"、删岗位）会带上它自己的来源，浏览器不允许网页伪造这个来源
 * 没有来源的请求照常处理：直接在地址栏打开、服务器自己的定时任务、本机命令行工具
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function allowedOrigin(origin: string) {
  try {
    const u = new URL(origin);
    if (u.protocol === "chrome-extension:" || u.protocol === "extension:") return true; // 投简助手插件
    return (u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOSTNAMES.has(u.hostname);
  } catch {
    return false; // 包括 "null"：沙箱页面、本地文件
  }
}

export function proxy(req: NextRequest) {
  const hostname = (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  if (!LOCAL_HOSTNAMES.has(hostname)) {
    return new NextResponse("SwipeApply只允许在本机访问", { status: 403 });
  }
  if (req.nextUrl.pathname.startsWith("/api/")) {
    const origin = req.headers.get("origin");
    if (origin && !allowedOrigin(origin)) {
      return NextResponse.json({ error: "不接受来自其他网站的请求" }, { status: 403 });
    }
  }
  return NextResponse.next();
}

export const config = {
  // 静态资源不用检查
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

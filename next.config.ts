import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 文件解析库只在服务端（你本机的 Node 进程）运行
  serverExternalPackages: ["mammoth", "unpdf", "tesseract.js", "jszip", "playwright-core"],
  // 只绑定本机（package.json 里 -H 127.0.0.1）；用 localhost 或 127.0.0.1 打开都能热更新
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;

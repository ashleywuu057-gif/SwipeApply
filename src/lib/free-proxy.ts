import "server-only";
import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

/**
 * 免费额度：没在 .env.local 里填自己的 Key 时，AI 请求走作者提供的中转（proxy/，部署在 Cloudflare Pages），
 * 用作者的 Key，每台电脑每天有固定额度。填了自己的 Key 就直接连 DeepSeek / 千问，不经过中转。
 *
 * 做法：在这里把没填的 LLM_* / SEARCH_LLM_* 补成中转的地址，Key 填本机的设备号（中转按它统计用量）。
 * 用到 AI 的模块都在开头 import 这个文件，所以不用改各处读配置的代码。
 * 不想用免费额度：在 .env.local 里写 SWIPEAPPLY_PROXY=off。
 */

export const FREE_PROXY = (process.env.SWIPEAPPLY_PROXY?.trim() || "https://swipeapply-api.pages.dev").replace(/\/$/, "");

/** 本机的设备号：第一次用时随机生成，存在 data/device.json，只用来统计免费额度 */
function deviceId(): string {
  const file = path.join(process.cwd(), "data", "device.json");
  try {
    const id = JSON.parse(readFileSync(file, "utf8")).id;
    if (/^sa-[0-9a-f-]{36}$/.test(id)) return id;
  } catch {}
  const id = `sa-${randomUUID()}`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ id }, null, 2));
  return id;
}

/** 现在是不是在用免费额度（给页面上的提示用） */
export const usingFreeProxy = () => process.env.SWIPEAPPLY_FREE === "1";

(function useFreeProxyIfNoKey() {
  if (process.env.SWIPEAPPLY_PROXY?.trim().toLowerCase() === "off" || process.env.SWIPEAPPLY_FREE) return;
  const needMain = !process.env.LLM_API_KEY?.trim();
  const needSearch = !process.env.SEARCH_LLM_API_KEY?.trim();
  if (!needMain && !needSearch) return;
  const id = deviceId();
  if (needMain) {
    process.env.LLM_API_KEY = id;
    process.env.LLM_BASE_URL = `${FREE_PROXY}/deepseek/v1`;
  }
  if (needSearch) {
    process.env.SEARCH_LLM_API_KEY = id;
    process.env.SEARCH_LLM_BASE_URL = `${FREE_PROXY}/compatible-mode/v1`; // 联网搜索的原生接口按这个地址的域名拼，中转的路径和千问一致
  }
  process.env.SWIPEAPPLY_FREE = "1";
})();

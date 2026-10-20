import "server-only";
import "../free-proxy"; // 没填自己的 Key 时走免费额度（必须在读 LLM_* 配置之前）
import type { ChannelGroup, Tier } from "./types";

/**
 * 联网搜索（通义千问联网搜索，沿用 .env.local 里的 SEARCH_LLM_* 配置，和岗位库的联网搜索共用一个 Key）。
 * 只发送 agent 生成的搜索词，搜索词里不会有你的个人信息——调研 agent 本身就拿不到你的素材库。
 *
 * 用的是 DashScope 原生接口而不是 OpenAI 兼容接口：只有原生接口能用 enable_source 拿到搜索结果的原始链接
 * （output.search_info.search_results：url、title、site_name）。千问搜索时一定会顺带生成一段回答，
 * 这段回答完全不用、也不返回给 agent，只取搜索结果列表；结论只能来自 agent 自己读过的网页原文。
 * 搜索结果没有摘要和发布日期：snippet 留空，date 只在链接里带日期时取出来。
 */
export function searchConfig() {
  const key = process.env.SEARCH_LLM_API_KEY?.trim() ?? "";
  const base = process.env.SEARCH_LLM_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  let origin = "https://dashscope.aliyuncs.com";
  try {
    origin = new URL(base).origin;
  } catch {}
  const model = process.env.SEARCH_LLM_MODEL?.trim() || "qwen-plus";
  return { enabled: Boolean(key), key, endpoint: `${origin}/api/v1/services/aigc/text-generation/generation`, model, provider: "通义千问" };
}

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  site: string;
  date?: string;
}

/** 渠道 → 优先的网站（千问搜索不能限定网站，在结果里按域名过滤） */
export const CHANNEL_SITES: Record<string, string[]> = {
  财报与交易所披露: ["hkexnews.hk", "cninfo.com.cn", "sse.com.cn", "szse.cn", "sec.gov", "investor", "ir."],
  研究机构: ["iresearch.com.cn", "questmobile.com.cn", "analysys.cn", "199it.com", "mckinsey.com.cn", "bain.cn", "36kr.com/p", "report"],
  行业媒体: ["36kr.com", "latepost.com", "huxiu.com", "geekpark.net", "tmtpost.com", "jiemian.com", "caixin.com", "yicai.com", "thepaper.cn", "woshipm.com", "leiphone.com", "ebrun.com"],
  公众号: ["mp.weixin.qq.com"],
  用户论坛: ["zhihu.com", "xiaohongshu.com", "douban.com", "tieba.baidu.com", "bilibili.com", "maimai.cn", "nowcoder.com"],
};

export const CHANNELS = ["不限", "官网", ...Object.keys(CHANNEL_SITES), "招聘广告"] as const;

export async function webSearch(query: string, opts: { channel?: string; freshness?: string; count?: number } = {}): Promise<SearchHit[]> {
  const cfg = searchConfig();
  if (!cfg.enabled) throw new Error("还没有配置 SEARCH_LLM_API_KEY（通义千问）");
  const sites = opts.channel ? CHANNEL_SITES[opts.channel] : undefined;
  // 千问搜索不能限定网站和时间范围：渠道、时间写进搜索词，结果再按域名过滤
  const channelHint: Record<string, string> = { 招聘广告: "招聘 岗位职责", 官网: "官网", 财报与交易所披露: "财报 公告", 研究机构: "研究报告", 公众号: "微信公众号", 用户论坛: "知乎 讨论" };
  const timeHint = opts.freshness === "oneMonth" ? "最近一个月" : opts.freshness === "oneYear" ? "最近一年" : "";
  const q = [query, opts.channel ? channelHint[opts.channel] : "", timeHint].filter(Boolean).join(" ");

  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      input: { messages: [{ role: "user", content: `搜索：${q}\n只需要搜索，回答"好"即可。` }] },
      parameters: {
        enable_search: true,
        search_options: { forced_search: true, enable_source: true, search_strategy: "max" },
        result_format: "message",
        max_tokens: 16, // 模型的回答不用，压到最短
      },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`搜索失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const json = await res.json();
  const items: Record<string, unknown>[] = json?.output?.search_info?.search_results ?? [];
  let hits: SearchHit[] = items
    .filter((r) => typeof r.url === "string" && /^https?:\/\//.test(r.url))
    .map((r) => ({
      url: r.url as string,
      title: String(r.title ?? ""),
      snippet: "",
      site: String(r.site_name || "") || hostOf(r.url as string),
      date: dateInUrl(r.url as string),
    }));
  if (sites?.length) {
    const filtered = hits.filter((h) => sites.some((s) => h.url.includes(s)));
    if (filtered.length) hits = filtered;
  }
  return hits.slice(0, Math.min(opts.count ?? 8, 8));
}

/** 很多新闻链接里带日期（/20260623/、/2025-04-02/）；取不到就不写，不猜 */
function dateInUrl(u: string) {
  const m = u.match(/(?<!\d)(20\d{2})[-/]?(0[1-9]|1[0-2])[-/]?(0[1-9]|[12]\d|3[01])(?!\d)/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

export function hostOf(u: string) {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return u;
  }
}

/** 按域名判断渠道类型和可信度 */
export function classifySource(url: string, companyHints: string[] = []): { group: ChannelGroup; channel: string; tier: Tier } {
  const host = hostOf(url);
  const u = url.toLowerCase();
  if (/hkexnews|cninfo|sse\.com\.cn|szse|sec\.gov|investor|\/ir\/|ir\./.test(u)) return { group: "官方公开资料", channel: "财报与交易所披露", tier: "A" };
  if (/jobs\.|careers?\.|campus|zhaopin|hr\.|join\./.test(u)) return { group: "官方公开资料", channel: "招聘广告", tier: "A" };
  if (companyHints.some((h) => h && host.includes(h.toLowerCase()))) return { group: "官方公开资料", channel: "官网", tier: "A" };
  if (/mp\.weixin\.qq\.com/.test(u)) return { group: "第三方渠道", channel: "公众号", tier: "C" };
  if (/iresearch|questmobile|analysys|199it|mckinsey|bain|deloitte|pwc|kpmg|ey\.com|gartner|idc\.com|report/.test(u)) return { group: "第三方渠道", channel: "研究机构", tier: "B" };
  if (/latepost|36kr|huxiu|caixin|yicai|jiemian|geekpark|tmtpost|thepaper|reuters|bloomberg|ft\.com|wsj|techcrunch|theinformation/.test(u)) return { group: "第三方渠道", channel: "行业媒体", tier: "B" };
  if (/zhihu|xiaohongshu|douban|tieba|bilibili|maimai|nowcoder|weibo|reddit/.test(u)) return { group: "第三方渠道", channel: "用户论坛", tier: "D" };
  return { group: "第三方渠道", channel: "一般媒体", tier: "C" };
}

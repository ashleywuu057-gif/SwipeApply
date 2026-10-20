/**
 * SwipeApply 免费额度中转（Cloudflare Pages Functions）。
 *
 * 没填自己 Key 的 SwipeApply 把 AI 请求发到这里，这里加上作者的 Key 再转给 DeepSeek / 通义千问。
 * - 只转 SwipeApply 用到的 4 个接口、只允许这几类模型，不能拿来当通用中转
 * - 按「每台电脑（设备号）/ 每个 IP / 所有人合计」统计每天用掉的 token，超了就停，作者每天最多花多少钱是定死的
 * - 不存请求内容，只存当天每个设备号、IP 用了多少 token（D1 数据库）
 *
 * 设备号：SwipeApply 第一次启动时随机生成（sa-<uuid>），放在请求的 Authorization: Bearer 里。
 */

interface Env {
  DEEPSEEK_KEY: string;
  DASHSCOPE_KEY: string;
  DB: D1Database;
  PER_DEVICE_TOKENS?: string; // 每台电脑每天，默认 20 万
  PER_IP_TOKENS?: string; // 每个 IP 每天，默认 40 万（同一个宿舍 / 公司网络可能有好几个人）
  GLOBAL_TOKENS?: string; // 所有人合计每天，默认 300 万
}

type Route = { upstream: string; key: "DEEPSEEK_KEY" | "DASHSCOPE_KEY"; models: RegExp };

// 路径和千问的官方接口一致：SwipeApply 只要把 SEARCH_LLM_BASE_URL 换成本站的 /compatible-mode/v1，联网搜索的原生接口地址就自动对上
const ROUTES: Record<string, Route> = {
  "/deepseek/v1/chat/completions": { upstream: "https://api.deepseek.com/v1/chat/completions", key: "DEEPSEEK_KEY", models: /^deepseek-/ },
  "/compatible-mode/v1/chat/completions": { upstream: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", key: "DASHSCOPE_KEY", models: /^qwen-(flash|turbo|plus)/ },
  "/compatible-mode/v1/embeddings": { upstream: "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings", key: "DASHSCOPE_KEY", models: /^text-embedding-v\d/ },
  "/api/v1/services/aigc/text-generation/generation": { upstream: "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation", key: "DASHSCOPE_KEY", models: /^qwen-(flash|turbo|plus)/ },
};

const MAX_BODY = 256 * 1024; // 一次请求最大 256KB
const MAX_OUTPUT = 32768; // 输出 token 上限（写简历的推理模型要这么多）
const DEVICE = /^sa-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 用 402 而不是 429：SwipeApply 遇到 429 会自动重试，额度用完了重试没有意义 */
const fail = (status: number, message: string) => Response.json({ error: { message } }, { status });

/** 按北京时间算「今天」：额度每天 0 点重置 */
const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
  const route = ROUTES[url.pathname];
  if (!route) return fail(404, "这里只给 SwipeApply 转发 AI 请求");
  if (request.method !== "POST") return fail(405, "只接受 POST");

  const device = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!DEVICE.test(device)) return fail(401, "缺少 SwipeApply 设备号，请用最新版 SwipeApply");
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";

  const raw = await request.text();
  if (raw.length > MAX_BODY) return fail(413, "请求太大");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "请求不是 JSON");
  }
  if (!route.models.test(String(body.model ?? ""))) return fail(403, `免费额度不支持模型 ${String(body.model ?? "")}`);
  if (typeof body.max_tokens === "number") body.max_tokens = Math.min(body.max_tokens, MAX_OUTPUT);
  if (body.stream) return fail(400, "免费额度不支持流式输出");

  // 查今天的用量
  const day = today();
  const who = [`d:${device}`, `ip:${ip}`, "all"];
  const limits = [Number(env.PER_DEVICE_TOKENS ?? 200_000), Number(env.PER_IP_TOKENS ?? 400_000), Number(env.GLOBAL_TOKENS ?? 3_000_000)];
  const rows = await env.DB.prepare("SELECT who, tokens FROM usage WHERE day = ? AND who IN (?, ?, ?)")
    .bind(day, ...who)
    .all<{ who: string; tokens: number }>();
  const used = (w: string) => rows.results.find((r) => r.who === w)?.tokens ?? 0;
  if (used("all") >= limits[2]) return fail(402, "今天的免费额度已经被大家用完了，明天 0 点重置。想不受限制地用，可以在 .env.local 里填自己的 Key（见 README）");
  if (used(who[0]) >= limits[0] || used(who[1]) >= limits[1])
    return fail(402, "你今天的免费额度用完了，明天 0 点重置。想不受限制地用，可以在 .env.local 里填自己的 Key（见 README）");

  // 转发
  const upstream = await fetch(route.upstream, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env[route.key]}` },
    body: JSON.stringify(body),
  });
  const text = await upstream.text();

  // 记用量（拿不到 usage 时按请求大小粗估，免得被白用）
  let tokens = Math.ceil(raw.length / 2);
  try {
    const u = JSON.parse(text)?.usage ?? {};
    tokens = Number(u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0)) || tokens;
  } catch {}
  if (upstream.ok) {
    await env.DB.batch(
      who.map((w) => env.DB.prepare("INSERT INTO usage (day, who, tokens) VALUES (?, ?, ?) ON CONFLICT(day, who) DO UPDATE SET tokens = tokens + excluded.tokens").bind(day, w, tokens)),
    );
  }
  return new Response(text, { status: upstream.status, headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" } });
};

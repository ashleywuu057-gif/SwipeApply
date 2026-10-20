import "server-only";
import "../free-proxy"; // 没填自己的 Key 时走免费额度（必须在读 LLM_* 配置之前）
import { llmConfig, llmPost, postJson } from "../extract";

/**
 * 新版的模型调用：一个通用的"带工具的对话循环"。
 * 模型决定调用哪个工具 → 程序执行（并做核对）→ 结果交还模型，直到它给出回复或用完步数。
 */
export type Msg = { role: string; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; [k: string]: unknown };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };

/** 换一个模型服务：轻活走更快的模型时用；不传就用 LLM_* 的主模型 */
export type ModelRef = { model: string; baseUrl?: string; apiKey?: string; extra?: Record<string, unknown>; maxOut?: number /* 这家服务允许的最大输出 token */ };
type ChatOpts = { tools?: ToolDef[]; json?: boolean; temperature?: number; timeoutMs?: number; maxTokens?: number; model?: string | ModelRef };

/**
 * 轻活（意图识别、偏好解析）用的快模型，不要思考过程：
 * 1. .env.local 填了 LLM_SMALL_MODEL（可选 LLM_SMALL_BASE_URL / LLM_SMALL_API_KEY）就用它；
 * 2. 没填但配了千问（SEARCH_LLM_*）就用 qwen-flash，关掉思考——实测意图识别 0.4 秒，主模型 deepseek-flash 要 3 秒以上，有时 90 秒都不返回；
 * 3. 都没有就用主模型。
 */
export function smallModel(): ModelRef | undefined {
  const model = process.env.LLM_SMALL_MODEL?.trim();
  if (model) return { model, baseUrl: process.env.LLM_SMALL_BASE_URL?.trim() || undefined, apiKey: process.env.LLM_SMALL_API_KEY?.trim() || undefined };
  const qwenKey = process.env.SEARCH_LLM_API_KEY?.trim();
  const qwenUrl = process.env.SEARCH_LLM_BASE_URL?.trim();
  if (qwenKey && qwenUrl) return { model: "qwen-flash", baseUrl: qwenUrl, apiKey: qwenKey, extra: { enable_thinking: false } };
  return undefined;
}

/**
 * 写简历用的模型：.env.local 里的 LLM_RESUME_MODEL（可选 LLM_RESUME_BASE_URL / LLM_RESUME_API_KEY）；没填就用主模型。
 * 填 qwen 开头的模型又没写地址时，走千问（SEARCH_LLM_*）的服务、关掉思考。
 */
export function resumeModel(): ModelRef | undefined {
  const model = process.env.LLM_RESUME_MODEL?.trim();
  if (!model) return undefined;
  const baseUrl = process.env.LLM_RESUME_BASE_URL?.trim();
  if (baseUrl) return { model, baseUrl, apiKey: process.env.LLM_RESUME_API_KEY?.trim() || undefined };
  if (/^qwen/i.test(model) && process.env.SEARCH_LLM_BASE_URL?.trim())
    return { model, baseUrl: process.env.SEARCH_LLM_BASE_URL.trim(), apiKey: process.env.SEARCH_LLM_API_KEY?.trim(), extra: { enable_thinking: false }, maxOut: 8192 };
  return { model };
}

export async function chat(messages: Msg[], opts: ChatOpts = {}) {
  return (await chatWithReason(messages, opts)).msg;
}

/** 同 chat，另外返回 finish_reason（"length" 表示输出被截断）。消息本身原样返回，工具循环会把它放回对话 */
async function chatWithReason(messages: Msg[], opts: ChatOpts): Promise<{ msg: Msg; finish?: string }> {
  const cfg = llmConfig();
  if (!cfg.enabled) throw new Error("还没有配置 LLM_API_KEY");
  const ref: ModelRef | undefined = typeof opts.model === "string" ? { model: opts.model } : opts.model;
  const body: Record<string, unknown> = { model: ref?.model ?? cfg.model, temperature: opts.temperature ?? 0.3, messages, ...ref?.extra };
  if (opts.maxTokens) body.max_tokens = ref?.maxOut ? Math.min(opts.maxTokens, ref.maxOut) : opts.maxTokens;
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({ type: "function", function: t }));
    body.tool_choice = "auto";
  }
  if (opts.json) body.response_format = { type: "json_object" };
  let json;
  if (ref?.baseUrl) {
    // 另一家服务（例如千问）：同样的建连超时和重试
    const url = ref.baseUrl.replace(/\/$/, "");
    json = await postJson(`${url}/chat/completions`, ref.apiKey ?? cfg.apiKey!, new URL(url).host, body, opts.timeoutMs);
  } else json = await llmPost(body, opts.timeoutMs);
  const choice = json.choices?.[0];
  return { msg: (choice?.message ?? { role: "assistant", content: "" }) as Msg, finish: choice?.finish_reason };
}

/** maxTokens：输出较长的调用要给足；被截断（finish_reason = length）解析不了时重试一次，还不行就报错说明原因 */
export async function chatJson<T = Record<string, unknown>>(system: string, user: string, temperature = 0.2, maxTokens?: number, model?: string | ModelRef): Promise<T | null> {
  for (let attempt = 1; ; attempt++) {
    const { msg, finish } = await chatWithReason(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { json: true, temperature, maxTokens, model, timeoutMs: maxTokens ? 300000 : undefined }, // 长输出（含思考）可能超过默认的 2 分钟
    );
    const out = parseLoose<T>(typeof msg.content === "string" ? msg.content : "");
    if (out || finish !== "length") return out;
    if (attempt >= 2) throw new Error("模型输出太长被截断了（超过输出长度上限），请稍后重试");
  }
}

export function parseLoose<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return null;
    }
  }
}

/**
 * 工具循环。exec 返回交给模型的文字；返回 { stop: true } 表示这一轮到此为止（例如要反问用户）。
 */
export async function runToolLoop(opts: {
  messages: Msg[];
  tools: ToolDef[];
  exec: (name: string, args: Record<string, unknown>) => Promise<string | { stop: true; text: string }>;
  maxSteps: number;
}): Promise<{ reply: string; steps: number; stopped: boolean }> {
  const { messages, tools, exec, maxSteps } = opts;
  let reply = "";
  for (let step = 1; step <= maxSteps; step++) {
    const last = step === maxSteps;
    const msg = await chat(messages, { tools: last ? undefined : tools });
    messages.push(msg); // 原样放回（包括思考内容），多轮工具调用需要
    const calls = msg.tool_calls ?? [];
    if (typeof msg.content === "string" && msg.content.trim()) reply = msg.content.trim();
    if (!calls.length) return { reply, steps: step, stopped: false };
    let stop = false;
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {}
      let out: string;
      try {
        const r = await exec(call.function.name, args);
        if (typeof r === "string") out = r;
        else {
          out = r.text;
          stop = true;
        }
      } catch (e) {
        out = `出错：${(e as Error).message}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: out });
    }
    if (stop) return { reply, steps: step, stopped: true };
  }
  return { reply, steps: maxSteps, stopped: false };
}

/* ---------------- 核对工具：数字不能凭空出现 ---------------- */

/** 取出一句话里的数字（3 个月、4.2 万、18%、120 万+ …），统一成可比较的形式 */
export function numbersIn(s: string): string[] {
  return (s.replace(/,(?=\d{3})/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n)));
}

const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** "五种""九十篇""二十余家""一百二十" → 阿拉伯数字（只处理到千，够用） */
export function cnToArabic(s: string) {
  return s.replace(/[零一二两三四五六七八九十百千]+/g, (w) => {
    let total = 0;
    let cur = 0;
    for (const ch of w) {
      if (ch in CN_DIGIT) cur = CN_DIGIT[ch];
      else {
        const unit = ch === "十" ? 10 : ch === "百" ? 100 : 1000;
        total += (cur || 1) * unit;
        cur = 0;
      }
    }
    return String(total + cur);
  });
}

/** 改写后的句子里，每个数字都必须在依据原句里出现过（依据写"五种"、改写成"5 种"也算有） */
export function numbersOk(text: string, source: string) {
  const have = new Set([...numbersIn(source), ...numbersIn(cnToArabic(source))]);
  const extra = numbersIn(text).filter((n) => !have.has(n));
  return { ok: extra.length === 0, extra };
}

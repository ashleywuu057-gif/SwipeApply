import "server-only";
import { newId } from "../store";
import { DIRECTIONS } from "../tracker-types";
import { chatJson, smallModel } from "./llm";
import type { MemoryData, PrefRule } from "./types";

/**
 * 一句话设偏好：你说"这周只看上海的 C 端产品岗，别推 To B"，模型把它拆成岗位流能用的偏好规则，排序立刻生效。
 * 模型只负责"理解这句话"；规则的种类、取值范围、权重都在本地核对，对不上的丢掉，所以不会出现岗位流不认识的规则。
 * 新规则和滑动学到的规则一样：看得见、能撤销，在「AI 记住的事」里能关掉、删除。
 */

const FIELDS = ["direction", "location", "company", "keyword", "overseas"] as const;
const MAX_DAYS = 60; // 带时限的偏好最长 60 天

/** rules / unclear 的格式和拆法：单独拆偏好、和意图识别合并成一次调用（intent.ts）共用 */
export const RULES_SHAPE = `"rules":[{"field":"direction|location|company|keyword|overseas","value":"…","weight":数字,"until":"YYYY-MM-DD 或 null","text":"给用户看的一句话"}],"unclear":"听不懂或做不到的部分，没有就空字符串"`;

const PROMPT = (now: Date) => `你帮一名应届生把 TA 对岗位推荐的要求，拆成几条偏好规则。
只输出 JSON：{${RULES_SHAPE}}

${prefGuide(now)}`;

// 日期在本地算好写进去，不让模型算星期（快模型会差一天）
export const prefGuide = (now: Date) => `今天是 ${localDay(now)}（周${"日一二三四五六"[now.getDay()]}），本周日是 ${localDay(new Date(now.getTime() + ((7 - now.getDay()) % 7) * 86400000))}，7 天后是 ${localDay(new Date(now.getTime() + 7 * 86400000))}。
rules 的字段：
- direction：岗位方向，value 只能是其中之一：${DIRECTIONS.filter((d) => d !== "其他").join("、")}
- location：城市，value 写城市名，例如"上海"
- company：公司，value 写公司名
- keyword：岗位名或行业里的关键词，例如"C端""To B""商业化""AI""游戏"
- overseas：海外 / 出海岗位，value 固定写 "true"，多推还是少推看 weight 的正负

权重 weight：
- "只看 / 只要 / 重点看"：40；"多推 / 想看 / 优先"：15
- "少推"：-15；"别推 / 不要 / 不考虑"：-40；"再也别推这家公司"：-100（只用于 company）
时限 until：
- 说了"这周""这几天""最近"等就写截止日期（这周 = 上面给的本周日；最近 / 这几天 = 上面给的 7 天后，直接照抄日期）；没说就是 null（长期有效）
text：一句简短中文，说清楚会怎么影响推荐，例如"这周优先推上海的岗位""不再推 To B 的岗位"。"只看"类写成"优先推"，因为其他岗位仍会排在后面
规则：
- 一句话可以拆出多条；同一个意思不要重复
- 不是岗位偏好的内容（例如"帮我改简历"）不要硬拆，写进 unclear
- 用户说的地名、公司名、关键词照原样写，不要扩写成别的词`;

export type Raw = { field?: string; value?: string; weight?: number; until?: string | null; text?: string };

/** 把一句话变成偏好规则（还没存） */
export async function parsePrefs(sentence: string, now = new Date()): Promise<{ rules: Omit<PrefRule, "id" | "createdAt">[]; unclear: string }> {
  const r = await chatJson<{ rules?: Raw[]; unclear?: string }>(PROMPT(now), sentence.slice(0, 300), 0.1, undefined, smallModel());
  if (!r) throw new Error("模型没有返回结果，请稍后再试");
  return checkRules(r, now);
}

/** 本地核对模型拆出的规则：字段、取值、权重范围、时限都对得上才留下 */
export function checkRules(r: { rules?: Raw[]; unclear?: string }, now = new Date()): { rules: Omit<PrefRule, "id" | "createdAt">[]; unclear: string } {
  const today = localDay(now);
  const latest = localDay(new Date(now.getTime() + MAX_DAYS * 86400000));
  const out: Omit<PrefRule, "id" | "createdAt">[] = [];
  for (const x of r.rules ?? []) {
    const field = FIELDS.find((f) => f === x.field);
    let value = String(x.value ?? "").trim().slice(0, 20);
    if (!field || !value) continue;
    if (field === "direction" && !(DIRECTIONS as readonly string[]).includes(value)) continue;
    let weight = Math.round(Number(x.weight));
    if (!Number.isFinite(weight) || weight === 0) continue;
    if (field === "overseas") {
      // 统一成"海外岗位 + 正负权重"：模型写成 "false" 时把方向翻过来，免得误伤国内岗位
      if (value === "false") weight = -weight;
      else if (value !== "true") continue;
      value = "true";
    }
    weight = Math.max(field === "company" ? -100 : -40, Math.min(40, weight));
    const until = typeof x.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.until) && x.until >= today ? (x.until > latest ? latest : x.until) : undefined;
    const text = String(x.text ?? "").trim().slice(0, 40) || defaultText(field, value, weight);
    if (out.some((o) => o.field === field && o.value === value)) continue;
    out.push({ text, field, value, weight, active: true, from: "一句话", until });
  }
  return { rules: out, unclear: String(r.unclear ?? "").trim().slice(0, 120) };
}

/** 存进长期记忆：同一字段、同一取值的旧规则被这次的替换（用户最新的说法为准） */
export function saveSaid(mem: MemoryData, rules: Omit<PrefRule, "id" | "createdAt">[]): PrefRule[] {
  const at = new Date().toISOString();
  const saved = rules.map((r) => ({ ...r, id: newId(), createdAt: at }));
  mem.rules = mem.rules.filter((old) => !saved.some((n) => n.field === old.field && n.value === old.value));
  mem.rules.push(...saved);
  return saved;
}

function defaultText(field: PrefRule["field"], value: string, weight: number) {
  const what = field === "overseas" ? "海外岗位" : field === "location" ? `${value}的岗位` : field === "company" ? `「${value}」的岗位` : `${value}岗位`;
  return weight > 0 ? `优先推${what}` : `少推${what}`;
}

function localDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

import "server-only";
import { llmConfig } from "../extract";
import { buildContext, redact, restore } from "../redact";
import { readLibrary } from "../store";
import { directionsOf, sectorsOf } from "../tracker-logic";
import { DIRECTIONS, SECTORS, type Direction, type Sector, type TrackerSettings } from "../tracker-types";
import type { ExperienceCard } from "../types";
import { readTracker, updateTracker } from "../tracker-store";
import { chatJson } from "./llm";
import { shared } from "./store";

/**
 * 第一次使用：导入简历后，AI 读你的经历，推断适合投的方向和行业，直接按它开始推岗位，不用再确认。
 * 简历反映的是过去，不一定是你想去的方向（例如做过咨询实习、但想投产品），所以首页会说明按什么推的，
 * 想换方向直接在卡片上方的对话框里说一句（一句话设偏好），或在表格视图里改。
 * 有模型时让模型判断（先在本地脱敏，标了「仅本地」的经历不发）；没有模型或模型出错时按岗位名的规则推断。
 */

/** 首页该显示什么：还没有经历卡片 → 请你上传简历；否则正常刷岗位 */
export function onboardStep(cards: number): "upload" | null {
  return cards ? null : "upload";
}

/**
 * 导入简历后第一次打开岗位流：还没有方向（以前手动设过方向的老用户不算）就让 AI 推断一次并直接生效。
 * 同时来的几个请求共用同一次推断。
 */
export async function autoFocus(): Promise<void> {
  return shared("auto-focus", async () => {
    const t = await readTracker();
    if (t.settings.onboardedAt || t.settings.myDirections.length) return;
    if (!(await readLibrary()).cards.length) return;
    const s = await suggestFocus();
    // 推断不出方向时也记下"已经推断过"，不会每次打开都重试；岗位流照常按匹配度推
    await updateTracker((d) => {
      const at = new Date().toISOString();
      if (s.directions.length) {
        d.settings.myDirections = s.directions;
        d.settings.autoFocus = { ...s, at };
      }
      if (s.sectors.length) d.settings.mySectors = s.sectors;
      d.settings.onboardedAt = at;
    });
  });
}

/** 首页说明"按什么推的"：只在自动设好的当天显示，你改过方向就不再显示 */
export function autoFocusNote(s: TrackerSettings, now = new Date()) {
  const a = s.autoFocus;
  if (!a) return null;
  const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (day(new Date(a.at)) !== day(now)) return null;
  if (a.directions.join() !== s.myDirections.join()) return null;
  return a;
}

export interface Suggestion {
  directions: Direction[];
  sectors: Sector[];
  why: string; // 一句话说明依据
  by: "AI" | "规则";
}

const PICK_DIRECTIONS = DIRECTIONS.filter((d) => d !== "其他");
const PICK_SECTORS = SECTORS.filter((s) => s !== "其他");

const PROMPT = `你帮一名应届生判断：按 TA 的实习和项目经历，秋招最适合投哪些岗位方向和行业。
只输出 JSON：{"directions":["…"],"sectors":["…"],"why":"一句话依据，30 字以内"}
- directions 从这些里选 1~3 个，按把握排序：${PICK_DIRECTIONS.join("、")}
- sectors 从这些里选 1~3 个，按把握排序：${PICK_SECTORS.join("、")}
- 看经历做的是什么事（职能），不只看岗位名；标了"学术"的经历（论文、课题）只作参考
- why 用经历本身说话，例如"多段商业化产品经历，集中在互联网大厂"
- 【公司1】【人名1】这类占位符保持原样，不要猜（会在本地还原成真实名称）`;

export async function suggestFocus(): Promise<Suggestion> {
  const lib = await readLibrary();
  const rules = byRules(lib.cards);
  const cloud = lib.cards.filter((c) => !c.localOnly);
  if (!llmConfig().enabled || !cloud.length) return rules;

  const ctx = buildContext(lib.settings, cloud.flatMap((c) => [c.company, c.role, ...c.details]));
  const map: Record<string, string> = {};
  const red = (t: string) => redact(t, ctx, map).text;
  const text = cloud
    .map((c, i) => `${i + 1}. ${red(c.company)} · ${red(c.role)}（${c.type}，${c.start}–${c.end}）\n${c.details.slice(0, 3).map((d) => `   - ${red(d)}`).join("\n")}`)
    .join("\n");
  try {
    const r = await chatJson<{ directions?: string[]; sectors?: string[]; why?: string }>(PROMPT, `经历：\n${text}`, 0.1);
    const directions = [...new Set((r?.directions ?? []).filter((d): d is Direction => (PICK_DIRECTIONS as string[]).includes(d)))].slice(0, 3);
    const sectors = [...new Set((r?.sectors ?? []).filter((s): s is Sector => (PICK_SECTORS as string[]).includes(s)))].slice(0, 3);
    if (!directions.length) return rules;
    return { directions, sectors: sectors.length ? sectors : rules.sectors, why: cleanWhy(restore(String(r?.why ?? ""), map)), by: "AI" };
  } catch {
    return rules;
  }
}

/** 没有模型时：按每段经历的岗位名和公司数一数，出现最多的方向和行业 */
function byRules(cards: ExperienceCard[]): Suggestion {
  const work = cards.filter((c) => !/论文|学位|课题|thesis|dissertation/i.test(`${c.company} ${c.role} ${c.type}`));
  const count = <T extends string>(xs: T[]) => {
    const m = new Map<T, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  };
  const directions = count(work.flatMap((c) => directionsOf(c.role).filter((d) => d !== "其他"))).slice(0, 3);
  const sectors = count(work.flatMap((c) => sectorsOf({ company: c.company, title: c.role, industry: "", note: "" }).filter((s) => s !== "其他"))).slice(0, 3);
  return { directions, sectors, why: directions.length ? "按你各段经历的岗位名推断" : "", by: "规则" };
}

/** 依据里还有没还原的占位符（模型自己编的），整句不显示，免得出现"集中在等大厂"这种残句 */
function cleanWhy(w: string) {
  const t = w.trim().slice(0, 60);
  return /【[^】]*】/.test(t) ? "" : t;
}

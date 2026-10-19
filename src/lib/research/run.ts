import "server-only";
import { chatJson } from "../extract";
import { buildContext, redact } from "../redact";
import { readLibrary } from "../store";
import { runResearchAgent } from "./agent";
import { buildReport } from "./report";
import { saveResearch } from "./store";
import type { Research } from "./types";

/** 正在运行的调研（放在全局对象上，不同接口之间共享） */
const g = globalThis as unknown as { __jobprepResearch?: Set<string> };
const running = (g.__jobprepResearch ??= new Set<string>());

export function isRunning(id: string) {
  return running.has(id);
}

/** 完整流程：选参照经历 → 阶段 A 调研 agent → 阶段 B 生成报告。进度随时写盘，页面轮询读取。 */
export async function runResearch(r: Research) {
  running.add(r.id);
  const save = () => saveResearch(r);
  const log = (kind: Research["trace"][number]["kind"], text: string) => r.trace.push({ at: new Date().toISOString(), kind, text });
  try {
    const lib = await readLibrary();
    const cards = lib.cards.filter((c) => !c.localOnly);

    // 1. 参照经历：手动指定，或者由模型从经历卡片里挑一段和岗位最相关的（卡片先脱敏）
    let ref = r.refCardId ? lib.cards.find((c) => c.id === r.refCardId && !c.localOnly) : undefined;
    if (!ref && cards.length) {
      log("阶段", "挑选和这个岗位最相关的一段经历作为竞品对比的参照");
      const ctx = buildContext(lib.settings, cards.map((c) => `${c.company} ${c.role} ${c.summary}`));
      const map: Record<string, string> = {};
      const list = cards.map((c, i) => redact(`${i + 1}. ${c.type} · ${c.role} · ${c.summary || c.details[0] || ""}`, ctx, map).text).join("\n");
      try {
        const out = await chatJson(
          `从候选人的经历里挑一段，用来和目标岗位所在的业务做竞品对比：优先选业务最接近（同行业、同类产品或同类用户）的一段。只输出 JSON：{"index": 编号}`,
          `【目标公司】${r.company}\n【岗位】${r.jobTitle}\n【JD】${r.jd.slice(0, 1500)}\n【经历】\n${list}`,
        );
        const idx = Number(out?.index) - 1;
        ref = cards[idx] ?? cards[0];
      } catch {
        ref = cards[0];
      }
    }
    if (ref) {
      r.refCardId = ref.id;
      r.refLabel = `${ref.company} · ${ref.role}`;
      r.refCompany = ref.company;
      log("阶段", `参照经历：${r.refLabel}`);
    } else {
      log("阶段", "素材库里没有可用的经历卡片，只调研目标公司");
    }

    // 2. 阶段 A：调研 agent（只接触公开信息）
    r.status = "调研中";
    log("阶段", "开始联网调研");
    await save();
    // 素材库里的敏感词（除目标公司和参照公司外）不允许出现在搜索词里
    const blocked = lib.settings.sensitiveTerms.filter((t) => t !== r.company && t !== r.refCompany);
    await runResearchAgent(r, { blockedTerms: blocked, save });

    // 3. 阶段 B：生成报告（不联网）
    r.status = "生成报告";
    log("阶段", `调研结束：读了 ${r.usage.reads} 个网页，记录 ${r.usage.accepted} 条发现（驳回 ${r.usage.rejected} 条）。开始生成报告`);
    await save();
    r.report = await buildReport(r, lib.cards, lib.settings);
    r.status = "完成";
    r.finishedAt = new Date().toISOString();
    log("结束", "报告已生成");
  } catch (e) {
    r.status = "失败";
    r.error = (e as Error).message;
    log("错误", r.error);
  } finally {
    running.delete(r.id);
    await save();
  }
}

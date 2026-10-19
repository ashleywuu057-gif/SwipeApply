import {
  cardKey,
  classifyWithLLM,
  classifyWithRules,
  extractCardsWithLLM,
  extractCardsWithRules,
  matchLocally,
  matchWithLLM,
  mergeDrafts,
  normalize,
  type Experience,
} from "@/lib/extract";
import { redactSources } from "@/lib/pipeline";
import { redact } from "@/lib/redact";
import { newId, readLibrary } from "@/lib/store";
import { splitText } from "@/lib/split";
import type { Assignment, CardRef, Category, DraftCard, Segment } from "@/lib/types";

/**
 * 导入第 3 步（只生成结果，不保存）：
 * 1. 给每份资料分类：简历 / 业务知识 / 项目复盘 / 工作源文件
 * 2. 从简历里识别经历，生成卡片草稿（描述只取原句）
 * 3. 把其他资料归到某段经历下，整篇原文保留，不总结
 */
export async function POST(req: Request) {
  const { sourceIds, mode } = (await req.json()) as { sourceIds: string[]; mode: "llm" | "rules" };
  const useLLM = mode === "llm";
  const { items, map, ctx } = await redactSources(sourceIds ?? []);
  const lib = await readLibrary();
  const errors: string[] = [];

  // 文件名、说明、小节标题里也可能有人名，发给模型前同样脱敏
  const safe = (t: string) => (t ? redact(t, ctx, map).text : t);

  // 1. 分类
  const categories = new Map<string, Category>();
  for (const it of items) {
    let c: Category;
    try {
      c = useLLM
        ? await classifyWithLLM(safe(it.source.name), safe(it.source.note), it.redacted)
        : classifyWithRules(it.source.name, it.original);
    } catch (e) {
      errors.push(`${it.source.name} 分类失败，已改用规则：${(e as Error).message}`);
      c = classifyWithRules(it.source.name, it.original);
    }
    categories.set(it.source.id, c);
  }

  // 2. 简历 → 卡片草稿
  const drafts: DraftCard[] = [];
  for (const it of items.filter((i) => categories.get(i.source.id) === "简历")) {
    try {
      const raw = useLLM ? await extractCardsWithLLM(it.redacted, map) : extractCardsWithRules(it.original);
      drafts.push(...raw.map((r) => normalize(r, it.source.id, it.original)));
    } catch (e) {
      errors.push(`${it.source.name} 识别经历失败：${(e as Error).message}`);
    }
  }
  const merged = mergeDrafts(drafts);
  for (const d of merged) {
    const hit = lib.cards.find((c) => cardKey(c) === cardKey(d) && cardKey(d) !== "|");
    if (hit) {
      d.mergeIntoId = hit.id;
      d.mergeIntoLabel = `${hit.company} · ${hit.role}`;
    }
  }

  // 3. 其他资料 → 归属
  const exps: Experience[] = [
    ...lib.cards.map((c) => ({ ref: { kind: "card" as const, id: c.id }, company: c.company, role: c.role, localOnly: c.localOnly })),
    ...merged
      .filter((d) => !d.mergeIntoId)
      .map((d) => ({ ref: { kind: "draft" as const, id: d.draftId }, company: d.company, role: d.role, localOnly: false })),
  ];
  // 发给模型的经历列表也要脱敏；标了"仅本地"的卡片不发
  const cloudExps = exps.filter((e) => !e.localOnly);
  const list = redact(
    cloudExps.map((e, i) => `${i}. ${e.company} · ${e.role}`).join("\n"),
    ctx,
    map,
  ).text;

  const assignments: Assignment[] = [];
  const same = (a: CardRef, b: CardRef) => (a?.kind ?? "") === (b?.kind ?? "") && (a?.id ?? "") === (b?.id ?? "");

  for (const it of items) {
    const category = categories.get(it.source.id)!;
    const base = { sourceId: it.source.id, name: it.source.name, category };
    if (category === "简历") {
      assignments.push({ ...base, target: null, by: useLLM ? "模型" : "规则" });
      continue;
    }

    // 整份文件的归属
    const fileLocal = matchLocally(it.source.name + " " + it.source.note, it.original, exps);
    let fileTarget: CardRef = fileLocal?.ref ?? null;
    const fileBy: Assignment["by"] = fileLocal ? "关键词匹配" : useLLM ? "模型" : "规则";
    if (!fileTarget && useLLM && cloudExps.length) {
      try {
        const idx = await matchWithLLM(safe(it.source.name), it.redacted.slice(0, 3000), list, cloudExps.length);
        if (idx !== null) fileTarget = cloudExps[idx].ref;
      } catch (e) {
        errors.push(`${it.source.name} 归属判断失败：${(e as Error).message}`);
      }
    }

    // 自动切分：按标题切成小节，每节单独分类、归属
    const sections = splitText(it.original);
    let segments: Segment[] | undefined;
    if (sections.length > 1) {
      segments = [];
      for (const sec of sections) {
        const text = it.original.slice(sec.start, sec.end);
        const red = redact(text, ctx, map).text;
        let cat: Category;
        try {
          cat = useLLM
            ? await classifyWithLLM(safe(it.source.name), safe(it.source.note), red, safe(sec.title))
            : classifyWithRules(sec.title, text, false);
        } catch {
          cat = classifyWithRules(sec.title, text, false);
        }
        const loc = matchLocally(sec.title, text, exps);
        let target: CardRef = loc?.ref ?? null;
        let by: Segment["by"] = loc ? "关键词匹配" : useLLM ? "模型" : "规则";
        if (!target && useLLM && cloudExps.length) {
          try {
            const idx = await matchWithLLM(safe(`${it.source.name} › ${sec.title}`), red.slice(0, 3000), list, cloudExps.length);
            if (idx !== null) target = cloudExps[idx].ref;
          } catch {}
        }
        // 小节里没提到公司时：复盘和工作文件跟随整份文件的归属，业务知识默认为通用
        if (!target && cat !== "业务知识" && fileTarget) {
          target = fileTarget;
          by = "随文件";
        }
        segments.push({
          id: newId(),
          title: sec.title,
          start: sec.start,
          end: sec.end,
          preview: text.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim().slice(0, 80),
          category: cat,
          target,
          by,
        });
      }
    }

    // 各小节分类和归属都一样 → 不需要切分，整份归类
    const uniform = !segments || segments.every((g) => g.category === segments![0].category && same(g.target, segments![0].target));
    if (segments && uniform) {
      assignments.push({ ...base, target: fileTarget, by: fileBy, segments, split: false });
    } else {
      assignments.push({ ...base, target: fileTarget, by: fileBy, segments, split: Boolean(segments) });
    }
  }

  return Response.json({ drafts: merged, assignments, errors });
}

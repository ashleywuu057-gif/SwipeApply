import { eligible, extractMany } from "@/lib/evidence";
import { uniq } from "@/lib/extract";
import { updateMemory } from "@/lib/native/store";
import { fillProfile, profileFromText } from "@/lib/profile-extract";
import { deleteSourceText, newId, readSourceText, saveSourceText, updateLibrary } from "@/lib/store";
import type { Assignment, CardRef, DraftCard, ExperienceCard, SourceDoc } from "@/lib/types";

type Body = {
  drafts: (DraftCard & { include: boolean; merge: boolean })[];
  assignments: Assignment[];
};

/** 保存导入结果：新建/合并卡片，写入每份资料的分类和归属 */
export async function POST(req: Request) {
  const { drafts, assignments } = (await req.json()) as Body;
  const now = new Date().toISOString();
  // 分类成「简历」的资料：先读出原文（切分后原文件会被删），之后在本机读出简历抬头
  const resumeTexts: string[] = [];
  for (const a of assignments ?? []) {
    const isResume = a.category === "简历" || Boolean(a.split && a.segments?.some((g) => g.category === "简历"));
    if (isResume) resumeTexts.push(await readSourceText(a.sourceId).catch(() => ""));
  }

  const removed: string[] = [];
  const touched: string[] = [];
  let toExtract: string[] = [];
  await updateLibrary(async (lib) => {
    const draftToCard = new Map<string, string>();

    for (const d of drafts ?? []) {
      if (!d.include) continue;
      const details = d.details.map((s) => s.trim()).filter(Boolean);
      const target = d.merge && d.mergeIntoId ? lib.cards.find((c) => c.id === d.mergeIntoId) : undefined;
      if (target) {
        target.details = uniq([...target.details, ...details]);
        target.sourceIds = uniq([...target.sourceIds, ...d.sourceIds]);
        target.warnings = uniq([...target.warnings, ...d.warnings]);
        target.summary ||= d.summary;
        target.start ||= d.start;
        target.end ||= d.end;
        target.updatedAt = now;
        draftToCard.set(d.draftId, target.id);
      } else {
        const card: ExperienceCard = {
          id: newId(),
          type: d.type,
          company: d.company,
          role: d.role,
          start: d.start,
          end: d.end,
          summary: d.summary,
          details,
          localOnly: d.localOnly,
          sourceIds: d.sourceIds,
          warnings: d.warnings,
          createdAt: now,
          updatedAt: now,
        };
        lib.cards.push(card);
        draftToCard.set(d.draftId, card.id);
      }
    }

    const resolve = (t: CardRef): string | null => {
      if (!t) return null;
      if (t.kind === "card") return lib.cards.some((c) => c.id === t.id) ? t.id : null;
      return draftToCard.get(t.id) ?? null;
    };

    for (const a of assignments ?? []) {
      const src = lib.sources.find((s) => s.id === a.sourceId);
      if (!src) continue;

      // 切分：每个小节变成一份独立资料，原文件移除（内容不重复）
      if (a.split && a.segments && a.segments.length > 1) {
        const text = await readSourceText(src.id);
        for (const g of a.segments) {
          const part = text.slice(g.start, g.end).trim();
          if (!part) continue;
          const doc: SourceDoc = {
            id: newId(),
            name: `${src.name} › ${g.title}`,
            kind: src.kind,
            note: src.note,
            chars: part.length,
            importedAt: src.importedAt,
            category: g.category,
            cardId: g.category === "简历" ? null : resolve(g.target),
            splitFrom: src.name,
          };
          await saveSourceText(doc.id, part);
          lib.sources.push(doc);
          touched.push(doc.id);
        }
        lib.sources = lib.sources.filter((s) => s.id !== src.id);
        removed.push(src.id);
        continue;
      }

      src.category = a.category;
      src.cardId = a.category === "简历" ? null : resolve(a.target);
      touched.push(src.id);
    }
    toExtract = touched.filter((sid) => {
      const s = lib.sources.find((x) => x.id === sid);
      return s && eligible(s, lib.cards);
    });
  });
  for (const id of removed) await deleteSourceText(id);
  // 复盘、工作文档：在后台提炼证据条目，不耽误这次保存
  if (toExtract.length) void extractMany(toExtract).catch(() => undefined);

  // 简历抬头（姓名、电话、邮箱、教育、技能）：只在本机按规则读，不发给模型；只填还空着的栏，导入最后一步让用户确认
  const found = resumeTexts.map(profileFromText).reduce((all, p) => ({ ...p, ...all }), {});
  const { profile, filled } = await updateMemory((m) => {
    const r = fillProfile(m.profile, found);
    m.profile = r.profile;
    return r;
  });
  return Response.json({ ok: true, profile, filled });
}

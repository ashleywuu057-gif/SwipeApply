import { newId, readLibrary, updateLibrary } from "@/lib/store";
import type { ExperienceCard } from "@/lib/types";

/** 首页：卡片 + 资料清单（不含原文） */
export async function GET() {
  const lib = await readLibrary();
  const cards = [...lib.cards].sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  return Response.json({ cards, sources: lib.sources });
}

/** 手动新建一张空白卡片 */
export async function POST() {
  const now = new Date().toISOString();
  const card: ExperienceCard = {
    id: newId(),
    type: "实习",
    company: "",
    role: "",
    start: "",
    end: "",
    summary: "",
    details: [],
    localOnly: false,
    sourceIds: [],
    warnings: [],
    createdAt: now,
    updatedAt: now,
  };
  await updateLibrary((lib) => {
    lib.cards.push(card);
  });
  return Response.json({ card });
}

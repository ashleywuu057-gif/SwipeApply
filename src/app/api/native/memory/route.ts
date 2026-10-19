import { newId } from "@/lib/store";
import { readMemory, updateMemory } from "@/lib/native/store";
import type { Profile } from "@/lib/native/types";

/** AI 记住的事：岗位偏好、写作偏好、补充事实、简历抬头。全部可以查看、关掉、删除 */
export async function GET() {
  const m = await readMemory();
  return Response.json({ rules: m.rules, writing: m.writing, facts: m.facts, profile: m.profile, swipes: m.swipes.length });
}

type Body =
  | { op: "toggle" | "delete"; kind: "rules" | "writing" | "facts"; id: string }
  | { op: "addWriting"; text: string }
  | { op: "profile"; profile: Partial<Profile> };

export async function POST(req: Request) {
  const b = (await req.json()) as Body;
  const m = await updateMemory((m) => {
    if (b.op === "addWriting") {
      const t = b.text.trim();
      if (t && !m.writing.some((w) => w.text === t)) m.writing.push({ id: newId(), text: t, active: true, createdAt: new Date().toISOString() });
    } else if (b.op === "profile") {
      m.profile = { ...m.profile, ...b.profile };
    } else {
      const list = m[b.kind] as { id: string; active?: boolean }[];
      const i = list.findIndex((x) => x.id === b.id);
      if (i >= 0) {
        if (b.op === "delete") list.splice(i, 1);
        else list[i].active = !list[i].active;
      }
    }
    return m;
  });
  return Response.json({ rules: m.rules, writing: m.writing, facts: m.facts, profile: m.profile });
}

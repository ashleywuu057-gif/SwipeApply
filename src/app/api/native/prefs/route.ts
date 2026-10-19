import { llmConfig } from "@/lib/extract";
import { parsePrefs, saveSaid } from "@/lib/native/say";
import { updateMemory } from "@/lib/native/store";

/** 一句话设偏好：模型把这句话拆成偏好规则，存进长期记忆，岗位流立刻按它排序 */
export async function POST(req: Request) {
  const { text } = (await req.json().catch(() => ({}))) as { text?: string };
  const sentence = String(text ?? "").trim();
  if (!sentence) return Response.json({ error: "说一句你想看什么岗位" }, { status: 400 });
  if (!llmConfig().enabled) return Response.json({ error: "没有配置大模型（.env.local 里的 LLM_*），暂时不能用一句话设偏好" }, { status: 400 });
  try {
    const { rules, unclear } = await parsePrefs(sentence);
    const saved = rules.length ? await updateMemory((m) => saveSaid(m, rules)) : [];
    return Response.json({ rules: saved, unclear });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

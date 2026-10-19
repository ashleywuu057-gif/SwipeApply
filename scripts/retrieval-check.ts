/**
 * 检索对比：取最多 10 个已经抓到 JD 的岗位，把"旧做法"（整段 JD 一次向量查询）和"新做法"
 * （按 JD 要点多路查询 + 关键词 + 每段经历最多 3 条）挑出的面试素材并排打印，再列出每个要点有没有素材覆盖。
 * 只读数据，不写任何东西（向量缓存除外）。人工看一遍哪边挑得更准。
 *
 * 运行（在项目根目录）：
 *   node --conditions=react-server --env-file=.env.local --import tsx scripts/retrieval-check.ts
 */
import { promises as fs } from "fs";
import path from "path";
import { buildPool, red } from "@/lib/native/resume";
import { readMemory } from "@/lib/native/store";
import type { JdInfo } from "@/lib/native/types";
import { rank } from "@/lib/retrieve";

const K = 8;

async function main() {
  const dir = path.join(process.cwd(), "data", "native", "jd");
  const jds: JdInfo[] = [];
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!f.endsWith(".json")) continue;
    const j = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as JdInfo;
    if (j.status === "ok" && j.text.length > 100) jds.push(j);
  }
  const tracker = JSON.parse(await fs.readFile(path.join(process.cwd(), "data", "tracker.json"), "utf8")) as { jobs: { id: string; company: string; title: string }[] };
  const pool = await buildPool(await readMemory());
  const local = new Set(pool.cards.filter((c) => c.localOnly).map((c) => c.id));
  const cands = pool.lines.filter((l) => (l.kind === "卡片原句" || l.kind === "资料证据") && !(l.cardId && local.has(l.cardId)));
  const items = cands.map((l) => ({ id: l.id, text: red(pool, l.embed ?? l.text), group: l.cardId }));
  const label = (id: string) => {
    const l = cands.find((x) => x.id === id)!;
    const c = pool.cards.find((x) => x.id === l.cardId);
    return `${id.padEnd(4)} [${c ? `${c.company}·${c.role}` : "?"}] ${l.text.replace(/\s+/g, " ").slice(0, 60)}`;
  };
  console.log(`素材 ${cands.length} 条，有 JD 的岗位 ${jds.length} 个\n`);

  for (const jd of jds.slice(0, 10)) {
    const job = tracker.jobs.find((j) => j.id === jd.jobId);
    const query = red(pool, `${job?.title ?? ""}\n${jd.text}`);
    const [oldR, newR] = [await rank(query, items, { k: K, legacy: true }), await rank(query, items, { k: K, perGroup: 3 })];
    console.log("=".repeat(100));
    console.log(`${job?.company ?? "?"} · ${job?.title ?? jd.jobId}（检索方式：${newR.by}）`);
    console.log("\n--- 旧 ---");
    oldR.ranked.forEach((x) => console.log("  " + label(x.id)));
    console.log("\n--- 新 ---");
    newR.ranked.forEach((x) => console.log(`  ${label(x.id)}${x.point !== undefined ? `  ← 要点${x.point + 1}` : ""}`));
    console.log("\n--- JD 要点覆盖 ---");
    newR.points.forEach((p, i) => {
      const hit = newR.ranked.filter((x) => x.point === i);
      const best = Math.max(0, ...hit.map((x) => x.pointSim ?? 0));
      console.log(`  ${hit.length ? "✓" : "✗"} 要点${i + 1}${hit.length && best ? `（相似度 ${best.toFixed(2)}）` : ""} ${p.slice(0, 50)}`);
    });
    const same = oldR.ranked.filter((x) => newR.ranked.some((y) => y.id === x.id)).length;
    console.log(`\n  新旧重合 ${same}/${K}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { readMemory } from "@/lib/native/store";
import { furthestStage, normCompany, sectorsOf } from "@/lib/tracker-logic";
import { readTracker } from "@/lib/tracker-store";
import { STAGE_RANK } from "@/lib/tracker-types";

/**
 * 导出「岗位 × 你的动作 → 结果」数据（CSV），以后训练排序模型用。
 * 每行一个岗位：投递记录一行；岗位流里跳过、收藏、右滑但没投的，各一行。
 */
const COLUMNS = [
  "来源", "动作", "公司", "岗位", "方向", "行业", "海外", "地点", "投递途径",
  "证据匹配分", "对上的点数", "差距数", "简历生成方式", "日期", "最远阶段", "当前阶段", "进入测评及以后", "进入面试及以后",
];

export async function GET() {
  const [t, mem] = await Promise.all([readTracker(), readMemory()]);
  const rows: (string | number | boolean | undefined)[][] = [];

  for (const a of t.applications) {
    const s = a.snapshot;
    const far = furthestStage(a);
    rows.push([
      "投递记录", "投递", a.company, a.title, s?.directions.join("|"), s?.sectors.join("|"), s?.overseas, s?.location, s?.via,
      s?.score, s?.reasonCount, s?.gapCount, s?.resumeBy, a.appliedAt.slice(0, 10), far, a.stage,
      STAGE_RANK[far] >= STAGE_RANK["测评"] ? 1 : 0, STAGE_RANK[far] >= STAGE_RANK["面试"] ? 1 : 0,
    ]);
  }

  // 已经有投递记录的公司不再重复出一行
  const applied = new Set(t.applications.map((a) => normCompany(a.company)));
  for (const w of mem.swipes) {
    if (applied.has(normCompany(w.company))) continue;
    const action = { skip: "跳过", save: "收藏", apply: "右滑未提交" }[w.action];
    rows.push([
      "岗位流", action, w.company, w.title, w.directions.join("|"), sectorsOf({ company: w.company, title: w.title, industry: "", note: "" }).join("|"),
      w.overseas, w.location, "", "", "", "", "", w.at.slice(0, 10), "", "", "", "",
    ]);
  }

  const cell = (v: string | number | boolean | undefined) => {
    const s = v === undefined ? "" : typeof v === "boolean" ? (v ? "1" : "0") : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // 开头加 BOM，Excel 打开中文不乱码
  const csv = "﻿" + [COLUMNS, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("求职数据.csv")}`,
    },
  });
}

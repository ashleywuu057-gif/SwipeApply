/**
 * 岗位卡片的匹配分（服务端排序和前端拿到 AI 分析后刷新卡片共用，不能引用 server-only 模块）。
 *
 * 匹配分只看「你的经历和这个岗位对不对得上」，不算你的偏好：
 * - 按 JD 分析过（知道差距）：JD 看重的点里有多少在你素材里找得到证据 → 40~95 分
 * - 没分析过：规则粗估，基础 45 分 + 每条匹配理由 8 分
 * 方向、行业、偏好规则、临近截止这些「你想不想看」只影响卡片顺序（见 rankOf），不加进匹配分——
 * 以前加在一起，几条偏好叠起来一大半卡片都顶到 99 分（2026-10-15 用户发现）。
 */
export type ScoreBasis = "证据" | "粗估";

export function evidenceScore(reasons: number, gaps: number): number {
  return Math.round(40 + (55 * reasons) / Math.max(1, reasons + gaps));
}

/** gaps 为 null 表示还没按 JD 分析过 */
export function cardScore(reasons: number, gaps: number | null): { score: number; scoreBasis: ScoreBasis } {
  const raw = gaps === null ? 45 + reasons * 8 : evidenceScore(reasons, gaps);
  return { score: Math.max(5, Math.min(99, Math.round(raw))), scoreBasis: gaps === null ? "粗估" : "证据" };
}

/** 排序用：匹配分 + 偏好调整（偏好决定先看哪张，不改匹配分） */
export const rankOf = (c: { score: number; adjust: number }) => c.score + c.adjust;

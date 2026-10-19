"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Application, Stage } from "@/lib/tracker-types";

/**
 * 投递漏斗（桑基图）：投递 → 测评/笔试/AI面 → 面试 → Offer。
 * 每一列下面是停在这一步的投递：还在进行中（浅灰）或未通过（淡红），只用文字标注。
 * 一条投递走过哪几步，看它的当前阶段、时间线事件和阶段记录（跳过某一步的，连线直接跨过去）。
 * 点节点列出这些公司，点公司打开详情。
 */

type Kind = "stage" | "wait" | "fail" | "offer" | "pass";
type NodeId = "apply" | "test" | "interview" | "offer" | "wait1" | "fail1" | "wait2" | "fail2" | "wait3" | "fail3" | "pass1" | "pass2";
type NodeDef = { id: NodeId; col: number; label: string; kind: Kind; hint: string };

const NODES: NodeDef[] = [
  { id: "apply", col: 0, label: "投递", kind: "stage", hint: "全部投递" },
  { id: "test", col: 1, label: "测评 / 笔试 / AI面", kind: "stage", hint: "收到过测评、笔试或 AI 面" },
  // 跳过某一步的投递（比如直接面试）从这里穿过去：不画节点、没有标签，免得连线压在别的节点上
  { id: "pass1", col: 1, label: "跳过测评", kind: "pass", hint: "" },
  { id: "wait1", col: 1, label: "等待回复", kind: "wait", hint: "投递后还没有下一步" },
  { id: "fail1", col: 1, label: "简历未通过", kind: "fail", hint: "投递后直接未通过或放弃" },
  { id: "interview", col: 2, label: "面试", kind: "stage", hint: "面试、HR 面" },
  { id: "pass2", col: 2, label: "跳过面试", kind: "pass", hint: "" },
  { id: "wait2", col: 2, label: "等测评结果", kind: "wait", hint: "停在测评、笔试或 AI 面，还没有结果" },
  { id: "fail2", col: 2, label: "测评未通过", kind: "fail", hint: "测评、笔试或 AI 面后未通过或放弃" },
  { id: "offer", col: 3, label: "Offer", kind: "offer", hint: "拿到 Offer" },
  { id: "wait3", col: 3, label: "面试中", kind: "wait", hint: "面试还没有结果" },
  { id: "fail3", col: 3, label: "面试未通过", kind: "fail", hint: "面试后未通过或放弃" },
];
const COLS = ["投递", "测评 / 笔试 / AI面", "面试", "Offer"];
const COL_NODE: NodeId[] = ["apply", "test", "interview", "offer"];

// 跟页面一样的灰黑基调：推进 = 深灰（页面主色），进行中 = 浅灰，未通过 = 淡红，Offer = 淡绿；
// 每个节点都有文字标签（「未通过」「Offer」写在字里），颜色不单独表意
const COLOR: Record<Kind, string> = { stage: "#111827", offer: "#059669", wait: "#cbd5e1", fail: "#f87171", pass: "#111827" };
// 连线比节点淡很多，节点和文字是主角
const LINK_OPACITY: Record<Kind, number> = { stage: 0.1, offer: 0.25, wait: 0.35, fail: 0.22, pass: 0.1 };

const GROUP: Partial<Record<Stage, 1 | 2 | 3>> = { 测评: 1, 笔试: 1, AI面: 1, 面试: 2, HR面: 2, Offer: 3 };
const STEP: NodeId[] = ["apply", "test", "interview", "offer"];
const STOP: Record<0 | 1 | 2, { wait: NodeId; fail: NodeId }> = {
  0: { wait: "wait1", fail: "fail1" },
  1: { wait: "wait2", fail: "fail2" },
  2: { wait: "wait3", fail: "fail3" },
};

/** 一条投递经过的节点，按顺序 */
export function pathOf(a: Application): NodeId[] {
  const seen = new Set<number>();
  const add = (s: string | undefined) => {
    const g = GROUP[s as Stage];
    if (g) seen.add(g);
  };
  add(a.stage);
  a.events.forEach((e) => add(e.kind));
  a.stageLog?.forEach((s) => add(s.stage));
  const steps = [0, ...[1, 2, 3].filter((g) => seen.has(g))];
  const path: NodeId[] = ["apply"];
  for (let i = 1; i < steps.length; i++) {
    for (let c = steps[i - 1] + 1; c < steps[i]; c++) path.push(c === 1 ? "pass1" : "pass2");
    path.push(STEP[steps[i]]);
  }
  const last = steps[steps.length - 1];
  if (last === 3) return path; // 拿到 Offer
  const ended = a.stage === "未通过" || a.stage === "放弃";
  path.push(STOP[last as 0 | 1 | 2][ended ? "fail" : "wait"]);
  return path;
}

type Layout = {
  nodes: (NodeDef & { x: number; y: number; h: number; value: number; apps: Application[] })[];
  links: { from: NodeId; to: NodeId; value: number; d: string; color: string; opacity: number }[];
};

const NODE_W = 10;
const LABEL_W = 110; // 最后一列右边留给标签
const GAP = 10;
const PAD_Y = 6;
const TOP = 18; // 列名

function layout(apps: Application[], width: number, height: number): Layout {
  const members = new Map<NodeId, Application[]>(NODES.map((n) => [n.id, []]));
  const linkVal = new Map<string, number>();
  for (const a of apps) {
    const p = pathOf(a);
    p.forEach((id) => members.get(id)!.push(a));
    for (let i = 1; i < p.length; i++) {
      const k = `${p[i - 1]}>${p[i]}`;
      linkVal.set(k, (linkVal.get(k) ?? 0) + 1);
    }
  }
  const shown = NODES.filter((n) => members.get(n.id)!.length > 0);
  const colTotals = [0, 1, 2, 3].map((c) => shown.filter((n) => n.col === c).reduce((s, n) => s + members.get(n.id)!.length, 0));
  const colCounts = [0, 1, 2, 3].map((c) => shown.filter((n) => n.col === c).length);
  const usable = height - PAD_Y * 2 - TOP;
  // 同一比例尺：最挤的那一列刚好放满
  const k = Math.min(...[0, 1, 2, 3].filter((c) => colTotals[c] > 0).map((c) => (usable - GAP * (colCounts[c] - 1)) / colTotals[c]));
  const left = 4;
  const right = LABEL_W;
  const colX = (c: number) => left + ((width - left - right - NODE_W) * c) / 3;

  const nodes: Layout["nodes"] = [];
  for (let c = 0; c < 4; c++) {
    let y = TOP + PAD_Y;
    for (const n of shown.filter((x) => x.col === c)) {
      const value = members.get(n.id)!.length;
      const h = Math.max(3, value * k);
      nodes.push({ ...n, x: colX(c), y, h, value, apps: members.get(n.id)! });
      y += h + GAP;
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<NodeId, number>();
  const inn = new Map<NodeId, number>();
  const links: Layout["links"] = [];
  // 出线按目标的上下顺序排，免得交叉
  const pairs = [...linkVal.entries()]
    .map(([key, value]) => ({ from: key.split(">")[0] as NodeId, to: key.split(">")[1] as NodeId, value }))
    .sort((a, b) => byId.get(a.from)!.y - byId.get(b.from)!.y || byId.get(a.to)!.y - byId.get(b.to)!.y);
  for (const l of pairs) {
    const s = byId.get(l.from)!;
    const t = byId.get(l.to)!;
    const w = l.value * k;
    const sy = s.y + (out.get(s.id) ?? 0);
    const ty = t.y + (inn.get(t.id) ?? 0);
    out.set(s.id, (out.get(s.id) ?? 0) + w);
    inn.set(t.id, (inn.get(t.id) ?? 0) + w);
    const x0 = s.x + (s.kind === "pass" ? 0 : NODE_W);
    const x1 = t.x;
    const xm = (x0 + x1) / 2;
    const d = `M${x0},${sy} C${xm},${sy} ${xm},${ty} ${x1},${ty} L${x1},${ty + w} C${xm},${ty + w} ${xm},${sy + w} ${x0},${sy + w} Z`;
    const kind = t.kind === "pass" ? "stage" : t.kind;
    links.push({ ...l, d, color: COLOR[kind], opacity: LINK_OPACITY[kind] });
  }
  return { nodes, links };
}

export default function FunnelSankey({ apps, onOpen }: { apps: Application[]; onOpen: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ text: string; x: number; y: number } | null>(null);
  const [picked, setPicked] = useState<NodeId | null>(null);
  const [hot, setHot] = useState<string | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(0, size.w);
  const L = useMemo(() => (plotW > 0 && size.h > 0 ? layout(apps, plotW, size.h) : null), [apps, plotW, size.h]);
  const total = apps.length;
  const pct = (n: number) => (total ? `${Math.round((100 * n) / total)}%` : "");
  const pickedNode = L?.nodes.find((n) => n.id === picked);

  const tip = (e: React.MouseEvent, text: string) => {
    const r = box.current!.getBoundingClientRect();
    setHover({ text, x: e.clientX - r.left, y: e.clientY - r.top });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={box} className="relative min-h-0 flex-1" onMouseLeave={() => setHover(null)}>
        {L && (
          <svg width={size.w} height={size.h} className="block" role="img" aria-label={`投递漏斗：共 ${total} 条投递`}>
            {L.links.map((l) => {
              const from = L.nodes.find((n) => n.id === l.from)!;
              const to = L.nodes.find((n) => n.id === l.to)!;
              const dim = picked && !picked.startsWith("pass") && l.from !== picked && l.to !== picked;
              return (
                <path
                  key={`${l.from}-${l.to}`}
                  d={l.d}
                  fill={l.color}
                  fillOpacity={hot === `${l.from}-${l.to}` ? Math.min(0.6, l.opacity * 2.2) : dim ? l.opacity * 0.35 : l.opacity}
                  className="cursor-pointer transition-[fill-opacity]"
                  onMouseMove={(e) => (setHot(`${l.from}-${l.to}`), tip(e, `${from.label} → ${to.label}：${l.value} 条（占全部 ${pct(l.value)}）`))}
                  onMouseLeave={() => setHot(null)}
                  onClick={() => setPicked(to.kind === "pass" ? null : l.to)}
                />
              );
            })}
            {COLS.map((c, i) => {
              // 只在这一步有人走到时写列名（比如还没有 Offer，就不写「Offer」）
              const n = L.nodes.find((x) => x.id === COL_NODE[i]);
              return n ? (
                <text key={c} x={n.x} y={10} className="fill-gray-400 text-[11px]">
                  {c}
                </text>
              ) : null;
            })}
            {L.nodes.filter((n) => n.kind !== "pass").map((n) => {
              const labelX = n.x + NODE_W + 6;
              const cy = n.y + n.h / 2;
              return (
                <g key={n.id} className="cursor-pointer" onClick={() => setPicked(picked === n.id ? null : n.id)} onMouseMove={(e) => tip(e, `${n.label}：${n.value} 条（${pct(n.value)}）· ${n.hint}，点击查看公司`)}>
                  {/* 命中区比节点大 */}
                  <rect x={n.x - 4} y={n.y - 2} width={NODE_W + 8} height={n.h + 4} fill="transparent" />
                  <rect x={n.x} y={n.y} width={NODE_W} height={n.h} rx={3} fill={COLOR[n.kind]} stroke={picked === n.id ? "#111827" : "none"} strokeWidth={1.5} strokeOpacity={0.6} />
                  {/* 白色描边垫底，标签压在连线上也看得清 */}
                  <text x={labelX} y={cy} dy="0.35em" className="select-none fill-gray-700 text-[12px]" stroke="white" strokeWidth={3} strokeLinejoin="round" style={{ paintOrder: "stroke" }}>
                    {n.label}
                    <tspan className="fill-gray-400" dx={6}>
                      {n.value}
                    </tspan>
                  </text>
                </g>
              );
            })}
          </svg>
        )}
        {hover && (
          <div className="pointer-events-none absolute z-10 max-w-64 rounded-lg bg-gray-900/90 px-2.5 py-1.5 text-xs text-white shadow-lg" style={{ left: Math.min(hover.x + 12, size.w - 200), top: hover.y + 12 }}>
            {hover.text}
          </div>
        )}
        {pickedNode && (
          <div className="absolute right-0 top-0 z-20 flex max-h-full w-60 flex-col rounded-xl bg-white/95 shadow-lg ring-1 ring-gray-200 backdrop-blur">
            <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-3 py-2 text-sm">
              <span className="font-medium">
                {pickedNode.label} <span className="font-normal text-gray-400">{pickedNode.value}</span>
              </span>
              <button className="text-xs text-gray-400 hover:text-gray-700" onClick={() => setPicked(null)} aria-label="关闭">
                ✕
              </button>
            </div>
            <ul className="min-h-0 overflow-y-auto py-1">
              {pickedNode.apps.map((a) => (
                <li key={a.id}>
                  <button className="flex w-full items-baseline gap-2 px-3 py-1 text-left text-sm hover:bg-gray-50" onClick={() => onOpen(a.id)}>
                    <span className="truncate">{a.company}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-gray-400">{a.stage}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

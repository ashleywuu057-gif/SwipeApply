/**
 * 按标题把一份资料切成若干小节（纯本地、不改写任何文字）。
 * 小节首尾相接、覆盖全文，所以切分后内容不会重复、也不会丢。
 */
export interface Section {
  title: string;
  start: number; // 在原文中的起止位置
  end: number;
}

type Level = { name: string; re: RegExp; maxLen?: number };

// 按优先级排列：先看最高级的标题，出现两次以上就用它来切
const LEVELS: Level[] = [
  { name: "h1", re: /^#\s+(.+)$/ },
  { name: "第X部分", re: /^(第[一二三四五六七八九十百\d]+[部分章节篇])\s*[:：、.．]?\s*(.*)$/, maxLen: 40 },
  { name: "h2", re: /^##\s+(.+)$/ },
  { name: "【】", re: /^【([^】]{2,24})】\s*$/ },
  { name: "一、", re: /^[一二三四五六七八九十]+[、.．]\s*(.+)$/, maxLen: 30 },
  { name: "h3", re: /^###\s+(.+)$/ },
  { name: "（一）", re: /^[（(][一二三四五六七八九十]+[)）]\s*(.+)$/, maxLen: 30 },
];

const MIN_BODY = 20; // 正文太短的小节并入上一节
const MIN_PREAMBLE = 60; // 第一个标题之前的内容太短就并入第一节

export function splitText(text: string): Section[] {
  const lines: { text: string; start: number; code: boolean }[] = [];
  let pos = 0;
  let inFence = false;
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    const isFence = t.startsWith("```");
    // 代码块里的 "# 注释" 不是标题
    lines.push({ text: t, start: pos, code: inFence || isFence });
    if (isFence) inFence = !inFence;
    pos += raw.length + 1;
  }

  for (const level of LEVELS) {
    const heads = lines
      .map((l, i) => ({ i, m: l.text.match(level.re) }))
      .filter((h) => h.m && !lines[h.i].code && (!level.maxLen || lines[h.i].text.length <= level.maxLen) && !/[。；;，,]$/.test(lines[h.i].text));
    if (heads.length < 2) continue;

    let sections: Section[] = heads.map((h, k) => ({
      title: cleanTitle(h.m!.slice(1).filter(Boolean).join(" ") || lines[h.i].text),
      start: lines[h.i].start,
      end: k + 1 < heads.length ? lines[heads[k + 1].i].start : text.length,
    }));

    // 开头部分
    const preamble = text.slice(0, sections[0].start);
    if (preamble.trim().length >= MIN_PREAMBLE) sections.unshift({ title: "开头", start: 0, end: sections[0].start });
    else sections[0].start = 0;

    // 太短的小节并入上一节
    sections = sections.reduce<Section[]>((acc, s) => {
      const body = text.slice(s.start, s.end).split("\n").slice(1).join("").trim();
      if (acc.length && body.length < MIN_BODY) acc[acc.length - 1].end = s.end;
      else acc.push({ ...s });
      return acc;
    }, []);

    return sections.length >= 2 ? sections : [{ title: "全文", start: 0, end: text.length }];
  }
  return [{ title: "全文", start: 0, end: text.length }];
}

function cleanTitle(s: string) {
  return s.replace(/^#+\s*/, "").replace(/[*_`]/g, "").trim().slice(0, 40) || "未命名小节";
}

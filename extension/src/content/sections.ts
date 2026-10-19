import { normalizeText } from '../shared/normalize';
import type { DegreeLevel, SectionKind } from '../shared/types';
import { isOwnElement, isVisible } from './dom-utils';

/** 分区与重复记录识别。只使用页面真实存在的标题与结构，不读取测试答案。 */

export interface SectionBinding {
  section: SectionKind;
  sectionInstanceId: string;
  root: Element;
  headingText: string;
  /** 标题与内容相邻时用这些 DOM 子树限定范围，不修改网页、不借整个父容器串区。 */
  contentRoots: Element[];
}

export interface RecordContainer {
  recordInstanceId: string;
  sectionInstanceId: string;
  section: SectionKind;
  root: Element;
  degreeHint: DegreeLevel | null;
  order: number;
}

const SECTION_KEYWORDS: Array<{ section: SectionKind; patterns: RegExp }> = [
  { section: 'education', patterns: /(教育|学历|就读|院校|学籍)/ },
  { section: 'internships', patterns: /(实习)/ },
  { section: 'workExperiences', patterns: /(工作经历|职业经历|任职经历)/ },
  { section: 'projects', patterns: /(项目)/ },
  { section: 'languages', patterns: /(语言|外语|语种)/ },
  { section: 'awards', patterns: /(获奖|荣誉|奖项)/ },
  { section: 'publications', patterns: /(论文|专著|科研成果|学术成果)/ },
  { section: 'certificates', patterns: /(证书|资质|资格认证)/ },
  { section: 'preferences', patterns: /(求职意向|期望|意向岗位|应聘意向)/ },
  { section: 'selfIntroduction', patterns: /(自我介绍|个人简介|自我评价|个人陈述|自我描述|个人描述)/ },
  { section: 'personal', patterns: /(基本信息|基础信息|个人信息|联系方式|申请人信息)/ },
];

const DEGREE_KEYWORDS: Array<{ level: DegreeLevel; patterns: RegExp }> = [
  { level: 'doctor', patterns: /(博士)/ },
  { level: 'master', patterns: /(硕士|研究生)/ },
  { level: 'bachelor', patterns: /(本科|学士)/ },
  { level: 'associate', patterns: /(大专|专科)/ },
];

export function sectionFromHeading(text: string): SectionKind | null {
  const value = normalizeText(text);
  if (!value) return null;
  for (const entry of SECTION_KEYWORDS) {
    if (entry.patterns.test(value)) return entry.section;
  }
  return null;
}

export function degreeFromText(text: string): DegreeLevel | null {
  const value = normalizeText(text);
  if (!value) return null;
  for (const entry of DEGREE_KEYWORDS) {
    if (entry.patterns.test(value)) return entry.level;
  }
  return null;
}

/**
 * 分区标题。除了标准标题元素，还要认国内 ATS 常用的
 * `<div class="block-title-xxxx">教育背景</div>`（CSS Modules 会给类名加随机后缀）。
 */
const HEADING_SELECTOR = [
  'legend', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role="heading"]',
  '[class*="section-title"]', '[class*="record-title"]', '[class*="block-title"]',
  '[class*="group-title"]', '[class*="module-title"]', '[class*="panel-title"]',
  '[class*="card-title"]', '[class*="form-title"]', '[class*="blockTitle"]', '[class*="sectionTitle"]',
].join(', ');

function headingTextOf(element: Element): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('input, select, textarea, button').forEach((node) => node.remove());
  return normalizeText(clone.textContent ?? '');
}

/** 页面级容器不能当作分区根，否则整页标题会把所有字段归到一个分区。 */
const NON_SECTION_ROOTS = new Set(['main', 'body', 'html', 'article', 'header', 'footer']);
/** 分区标题是短标题；页面标题一类的长句不算分区。 */
const MAX_HEADING_LENGTH = 20;

/** 无语义标签的短分区标题只接受完整词，不把“学校名称”等字段名升级成分区。 */
const PLAIN_SECTION_TITLE = /^(?:基本信息|基础信息|个人信息|联系方式|教育(?:经历|背景|信息)|实习(?:经历|经验)|工作经历|项目(?:经历|经验)|获奖(?:情况|经历)|荣誉奖项|语言能力|语言技能|论文(?:发表|成果|信息)?|论文\/专著|证书(?:信息)?|资格证书|求职意向|自我评价|自我介绍|校园经历|在校经历|专利(?:成果|信息)?|技能(?:证书)?|其他信息|招聘信息来源|简历附件)$/;

function eligibleHeading(element: Element): boolean {
  if (isOwnElement(element) || !isVisible(element) || element.closest('nav, a, button, label, [role="tablist"], [role="dialog"]')) return false;
  if (element.querySelector('input, textarea, select, [role="combobox"], .am-list-item')) return false;
  const text = headingTextOf(element).replace(/[＊*：:]$/u, '').trim();
  return text.length > 0 && text.length <= MAX_HEADING_LENGTH &&
    (element.matches(HEADING_SELECTOR) || PLAIN_SECTION_TITLE.test(text));
}

/** 标题所属的分区容器：legend 归 fieldset，其余归父元素。 */
function rootForHeading(heading: Element): Element | null {
  if (heading.tagName.toLowerCase() === 'legend') {
    return heading.closest('fieldset');
  }
  const parent = heading.parentElement;
  if (!parent) return null;
  return NON_SECTION_ROOTS.has(parent.tagName.toLowerCase()) ? null : parent;
}

export interface StructureAnalysis {
  sections: SectionBinding[];
  records: RecordContainer[];
  sectionOfControl: Map<Element, SectionBinding>;
  recordOfControl: Map<Element, RecordContainer>;
}

interface SectionCandidate {
  section: SectionKind;
  root: Element;
  headingText: string;
  depth: number;
  contentRoots: Element[];
  key: Element;
}

function depthOf(element: Element): number {
  let depth = 0;
  let node: Element | null = element;
  while (node) {
    depth += 1;
    node = node.parentElement;
  }
  return depth;
}

function countControls(container: Element, controls: Element[]): number {
  let count = 0;
  for (const control of controls) if (container.contains(control)) count += 1;
  return count;
}

function hasAddButton(root: Element): boolean {
  return [...root.querySelectorAll('button, a, [role="button"]'), ...(root.matches('button, a, [role="button"]') ? [root] : [])]
    .some((button) => isVisible(button) && /^\+?\s*(?:添加|新增)(?:经历)?$/.test(normalizeText(button.textContent ?? '')));
}

export function sectionContains(section: SectionBinding, element: Element): boolean {
  return section.contentRoots.some((root) => root.contains(element));
}

/** 标题可能单独包在装饰容器中；仅沿最多三层找同级内容，到任何下一个标题即停止。 */
function siblingContent(heading: Element, headings: Element[], controls: Element[]): { root: Element; contentRoots: Element[] } | null {
  let marker = heading;
  for (let hop = 0; hop < 3 && marker.parentElement; hop += 1) {
    const roots: Element[] = [];
    let next = marker.nextElementSibling;
    while (next) {
      if (headings.some((other) => other !== heading && next!.contains(other)) ||
          next.matches('nav, footer, header, [role="dialog"]')) break;
      if (!isOwnElement(next)) roots.push(next);
      next = next.nextElementSibling;
    }
    const hasContent = roots.some((node) => controls.some((control) => node.contains(control)) || hasAddButton(node));
    if (hasContent) return { root: marker.parentElement, contentRoots: roots };
    const parent = marker.parentElement;
    // 只越过单个标题的纯装饰包装，不能越过已有字段/其它标题进入另一个区域。
    if (controls.some((control) => parent.contains(control)) ||
        headings.some((other) => other !== heading && parent.contains(other))) break;
    marker = parent;
  }
  return null;
}

/**
 * 找重复记录容器：从分区根向下走，直到出现多个各自包含 ≥2 个控件的兄弟容器。
 * 找不到时整个分区视为一条记录，避免把全页同名字段按下标乱配。
 */
function findRecordContainers(root: Element, controls: Element[]): Element[] {
  let node: Element = root;
  for (let depth = 0; depth < 8; depth += 1) {
    const children = [...node.children].filter(
      (child) => !isOwnElement(child) && controls.some((control) => child.contains(control)),
    );
    if (children.length === 0) break;
    if (children.length === 1) {
      node = children[0]!;
      continue;
    }
    const rich = children.filter((child) => countControls(child, controls) >= 2);
    if (rich.length >= 2) return rich;
    break;
  }
  return [root];
}

const REPEATED_SECTIONS: SectionKind[] = [
  'education', 'workExperiences', 'internships', 'projects', 'languages', 'awards', 'publications', 'certificates',
];

export function analyzeStructure(root: ParentNode, controls: Element[]): StructureAnalysis {
  const candidates: SectionCandidate[] = [];
  const allHeadings = [...root.querySelectorAll(`${HEADING_SELECTOR}, div, span, p, strong`)].filter(eligibleHeading);
  // 已有的语义/平台标题优先保留（其父级才是分区）；仅对纯文本包装取最内层。
  const headings = allHeadings.filter((heading) => !allHeadings.some((other) =>
    other !== heading && headingTextOf(other) === headingTextOf(heading) && (
      (other.contains(heading) && other.matches(HEADING_SELECTOR)) ||
      (heading.contains(other) && !heading.matches(HEADING_SELECTOR))
    )));
  for (const heading of headings) {
    const text = headingTextOf(heading);
    const kinds = SECTION_KEYWORDS.filter((entry) => entry.patterns.test(text));
    const section = kinds.length === 1 ? kinds[0]!.section : 'unknown';
    const container = rootForHeading(heading);
    const foreignHeading = container && headings.some((other) => other !== heading && container.contains(other) &&
      sectionFromHeading(headingTextOf(other)) !== section);
    if (container && !foreignHeading && (controls.some((control) => container.contains(control)) || hasAddButton(container))) {
      candidates.push({ section, root: container, contentRoots: [container], key: container,
        headingText: text, depth: depthOf(container) });
      continue;
    }
    const sibling = siblingContent(heading, headings, controls);
    if (sibling) {
      candidates.push({ section, ...sibling, key: heading, headingText: text, depth: depthOf(sibling.root) + 1 });
    } else if (container && !foreignHeading) {
      candidates.push({ section, root: container, contentRoots: [container], key: container,
        headingText: text, depth: depthOf(container) });
    }
  }

  // 同一容器只保留最具体的一个标题。
  const byRoot = new Map<Element, SectionCandidate>();
  for (const candidate of candidates) {
    const existing = byRoot.get(candidate.key);
    if (!existing || candidate.depth > existing.depth) byRoot.set(candidate.key, candidate);
  }
  const unique = [...byRoot.values()].sort((a, b) => b.depth - a.depth);

  const sections: SectionBinding[] = unique.map((candidate, index) => ({
    section: candidate.section,
    sectionInstanceId: `sec-${index}`,
    root: candidate.root,
    headingText: candidate.headingText,
    contentRoots: candidate.contentRoots,
  }));

  // 控件归属最内层的分区。
  const sectionOfControl = new Map<Element, SectionBinding>();
  for (const control of controls) {
    let best: SectionBinding | null = null;
    let bestDepth = -1;
    for (const section of sections) {
      if (!sectionContains(section, control)) continue;
      const depth = Math.max(...section.contentRoots.filter((node) => node.contains(control)).map(depthOf));
      if (depth > bestDepth) {
        best = section;
        bestDepth = depth;
      }
    }
    if (best) sectionOfControl.set(control, best);
  }

  // 重复分区：同类型多个分区根各算一条记录；单个分区根则向下找重复容器。
  const records: RecordContainer[] = [];
  const recordOfControl = new Map<Element, RecordContainer>();
  const grouped = new Map<SectionKind, SectionBinding[]>();
  for (const section of sections) {
    if (!REPEATED_SECTIONS.includes(section.section)) continue;
    const bucket = grouped.get(section.section);
    if (bucket) bucket.push(section);
    else grouped.set(section.section, [section]);
  }

  for (const [kind, bindings] of grouped) {
    // 排除只作为外层包裹的分区根（其内部还有同类分区）。
    const leaves = bindings.filter(
      (binding) => !bindings.some((other) => other !== binding &&
        other.contentRoots.every((node) => sectionContains(binding, node))),
    );
    const containers: Array<{ element: Element; binding: SectionBinding }> = [];
    if (leaves.length > 1) {
      for (const binding of leaves) {
        for (const element of binding.contentRoots) {
          if (controls.some((control) => sectionOfControl.get(control) === binding && element.contains(control))) {
            containers.push({ element, binding });
          }
        }
      }
    } else if (leaves.length === 1) {
      const binding = leaves[0]!;
      const owned = controls.filter((control) => sectionOfControl.get(control) === binding);
      for (const root of binding.contentRoots) {
        if (!owned.some((control) => root.contains(control))) continue;
        for (const element of findRecordContainers(root, owned)) containers.push({ element, binding });
      }
    }

    containers.forEach((entry, index) => {
      const record: RecordContainer = {
        recordInstanceId: `${kind}-rec-${index}`,
        sectionInstanceId: entry.binding.sectionInstanceId,
        section: kind,
        root: entry.element,
        degreeHint: kind === 'education'
          ? degreeFromText(headingTextOf(entry.element).slice(0, 120)) ?? degreeFromText(entry.binding.headingText)
          : null,
        order: index,
      };
      records.push(record);
      for (const control of controls) {
        if (entry.element.contains(control) && sectionOfControl.get(control) === entry.binding) {
          recordOfControl.set(control, record);
        }
      }
    });
  }

  return { sections, records, sectionOfControl, recordOfControl };
}

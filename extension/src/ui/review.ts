import { CATALOG, describeFieldRef, getSection } from '../shared/field-catalog';
import type { FieldRef, FieldResult, ProfileFile, ReasonCode, RunReport } from '../shared/types';
import { byId, clear, describeError, el, on, send, toast, type StateView } from './common';

/** 结果清单：按状态筛选、定位、单项重试与手动映射。 */

export const summaryLabels: Record<string, string> = {
  ready: '可自动填写',
  filled: '已填写',
  unchanged: '原值相同',
  preserved: '保留原值',
  pending: '待处理',
  failed: '失败',
};

export const reasonLabels: Record<ReasonCode, string> = {
  READY_TO_FILL: '已匹配，等待一键填写',
  FILLED_VERIFIED: '已填写并回读确认',
  VALUE_ALREADY_EQUAL: '网页原值与履历相同',
  EXISTING_VALUE: '网页已有不同内容，已保留原值',
  SOURCE_MISSING: '履历中没有这一项内容',
  AMBIGUOUS_FIELD: '有多个同样有力的候选字段',
  AMBIGUOUS_RECORD: '无法确定对应哪一段经历',
  AMBIGUOUS_OPTION: '找不到唯一对应的选项',
  UNSUPPORTED_WIDGET: '这种控件需要手动处理',
  PRECISION_MISMATCH: '日期精度不足，无法按已配置的默认值补齐',
  TEXT_TOO_LONG: '内容超过网页字数限制',
  REQUIRES_USER_ACTION: '需要你自己确认或操作',
  STALE_PAGE: '页面结构已变化',
  VALIDATION_FAILED: '网页校验没有通过',
  TIMEOUT: '等待超时',
  USER_CANCELLED: '已被停止',
  NO_MATCH: '没有找到对应的履历字段',
  RULE_STALE: '保存的规则已不适用',
};

interface RunSnapshot {
  report: RunReport;
  planned: number;
  summary: Record<string, number>;
  descriptors: Array<{
    fieldId: string;
    label: string;
    section: string;
    controlKind: string;
    required: boolean;
    empty: boolean;
    options: number;
    unsupportedReason: string | null;
    recordInstanceId: string | null;
  }>;
  jobCandidate: { company: string | null; role: string | null; location: string | null; externalJobId: string | null; sourceUrl: string | null } | null;
  notes: string[];
  excessEmptyRecordInstanceIds: string[];
}

let filter: string = 'all';

function activeProfile(state: StateView): ProfileFile | null {
  return state.profiles.find((entry) => entry.profileVersionId === state.activeProfileVersionId) ?? null;
}

/** 源字段选择器：显示「硕士教育 / 软件工程 / 专业」，用户不需要输入任何代码路径。 */
function buildSourceSelect(profile: ProfileFile | null): HTMLSelectElement {
  const select = el('select', { class: 'source-select', 'aria-label': '选择履历中的源字段' });
  select.append(el('option', { value: '', text: '请选择履历字段…' }));
  if (!profile) return select;

  for (const section of CATALOG) {
    if (!section.repeated) {
      const group = el('optgroup', { label: section.label });
      for (const field of section.fields) {
        const ref: FieldRef = { section: section.section, field: field.field };
        group.append(el('option', { value: JSON.stringify(ref), text: `${section.label} / ${field.label}` }));
      }
      select.append(group);
      continue;
    }
    const records = (profile.data as unknown as Record<string, Array<Record<string, unknown>>>)[section.section] ?? [];
    for (const record of records) {
      const recordId = String(record['id']);
      const title = String(record['school'] ?? record['company'] ?? record['name'] ?? record['language'] ?? recordId);
      const group = el('optgroup', { label: `${section.label} · ${title}` });
      for (const field of section.fields) {
        const ref: FieldRef = { section: section.section, recordId, field: field.field };
        group.append(el('option', { value: JSON.stringify(ref), text: `${title} / ${field.label}` }));
      }
      select.append(group);
    }
  }
  return select;
}

function fieldRow(
  field: FieldResult,
  snapshot: RunSnapshot,
  state: StateView,
  reload: () => void,
): HTMLElement {
  const profile = activeProfile(state);
  const descriptor = snapshot.descriptors.find((item) => item.fieldId === field.fieldId);
  const sectionLabel = getSection(field.section)?.label ?? '未归类';

  const row = el('div', { class: `field-row outcome-${field.outcome}` });
  const head = el('div', { class: 'field-head' }, [
    el('span', { class: `badge badge-${field.outcome}`, text: summaryLabels[field.outcome] ?? field.outcome }),
    el('strong', { class: 'field-label', text: field.label }),
    el('span', { class: 'field-meta', text: `${sectionLabel} · ${descriptor?.controlKind ?? '未知控件'}` }),
  ]);
  row.append(head);

  const reasonText = descriptor?.unsupportedReason ?? reasonLabels[field.reasonCode] ?? field.reasonCode;
  row.append(el('div', { class: 'field-reason', text: reasonText }));
  if (field.source && profile) {
    row.append(el('div', { class: 'field-source', text: `源字段：${describeFieldRef(profile.data, field.source)}` }));
  }

  const actions = el('div', { class: 'field-actions' });

  const locate = el('button', { type: 'button', class: 'ghost', text: '定位' });
  on(locate, 'click', () => {
    void send('LOCATE_FIELD', { runId: snapshot.report.id, fieldId: field.fieldId })
      .then(() => toast('已在网页中高亮该字段', 'success'))
      .catch((error: unknown) => toast(describeError(error), 'error'));
  });
  actions.append(locate);

  if (field.outcome === 'pending' || field.outcome === 'failed' || field.outcome === 'preserved') {
    const select = buildSourceSelect(profile);
    const remember = el('label', { class: 'inline' }, [
      el('input', { type: 'checkbox', class: 'remember-box' }),
      '记住这个对应关系',
    ]);
    const overwrite = el('label', { class: 'inline' }, [
      el('input', { type: 'checkbox', class: 'overwrite-box' }),
      '允许覆盖网页已有内容',
    ]);
    const apply = el('button', { type: 'button', class: 'primary', text: '应用到此字段' });

    on(apply, 'click', () => {
      const raw = select.value;
      if (!raw) {
        toast('请先选择一个履历字段', 'error');
        return;
      }
      const source = JSON.parse(raw) as FieldRef;
      const rememberChecked = (remember.querySelector('.remember-box') as HTMLInputElement).checked;
      const overwriteChecked = (overwrite.querySelector('.overwrite-box') as HTMLInputElement).checked;
      apply.setAttribute('disabled', '');
      void send<{ outcome: { outcome: string; reasonCode: ReasonCode }; verified: boolean; mappingSaved: boolean }>(
        'RETRY_FIELD',
        {
          runId: snapshot.report.id,
          fieldId: field.fieldId,
          source,
          remember: rememberChecked,
          overwriteExisting: overwriteChecked,
        },
      )
        .then((result) => {
          if (result.verified) {
            toast(result.mappingSaved ? '已填写并保存规则' : '已填写', 'success');
          } else {
            toast(`未能填写：${reasonLabels[result.outcome.reasonCode] ?? result.outcome.reasonCode}`, 'error');
          }
          reload();
        })
        .catch((error: unknown) => {
          toast(describeError(error), 'error');
          apply.removeAttribute('disabled');
        });
    });

    const controls = el('div', { class: 'retry-controls' }, [select, remember, overwrite, apply]);
    row.append(controls);
  }

  row.append(actions);
  return row;
}

/**
 * 一组网页经历无法确定对应哪条履历时，让用户一次性指定，整组字段随即填写。
 * 这比逐个字段手动映射快得多，也是「不猜」的正确出口。
 */
function ambiguousRecordPanels(
  snapshot: RunSnapshot,
  state: StateView,
  reload: () => void,
): HTMLElement[] {
  const profile = activeProfile(state);
  if (!profile) return [];

  const groups = new Map<string, { section: string; labels: string[] }>();
  for (const field of snapshot.report.fields) {
    if (field.reasonCode !== 'AMBIGUOUS_RECORD') continue;
    const descriptor = snapshot.descriptors.find((item) => item.fieldId === field.fieldId);
    const instanceId = descriptor?.recordInstanceId;
    if (!instanceId) continue;
    const existing = groups.get(instanceId);
    if (existing) existing.labels.push(field.label);
    else groups.set(instanceId, { section: field.section, labels: [field.label] });
  }

  const panels: HTMLElement[] = [];
  for (const [instanceId, group] of groups) {
    const section = getSection(group.section as never);
    const records = section
      ? ((profile.data as unknown as Record<string, Array<Record<string, unknown>>>)[group.section] ?? [])
      : [];
    if (records.length === 0) continue;

    const select = el('select', { class: 'record-select', 'aria-label': '选择这一组网页字段对应的经历' });
    select.append(el('option', { value: '', text: '请选择对应的经历…' }));
    for (const record of records) {
      const id = String(record['id']);
      const title = String(record['school'] ?? record['company'] ?? record['name'] ?? record['language'] ?? id);
      const detail = String(record['major'] ?? record['title'] ?? record['role'] ?? record['certificate'] ?? '');
      select.append(el('option', { value: id, text: detail ? `${title} · ${detail}` : title }));
    }

    const apply = el('button', { type: 'button', class: 'primary', text: '整组填写' });
    on(apply, 'click', () => {
      if (!select.value) {
        toast('请先选择对应的经历', 'error');
        return;
      }
      apply.setAttribute('disabled', '');
      void send<{ filled: number; pending: number }>('BIND_RECORD', {
        runId: snapshot.report.id,
        recordInstanceId: instanceId,
        recordId: select.value,
        remember: false,
      })
        .then((result) => {
          toast(`这一组已填写 ${result.filled} 项，仍有 ${result.pending} 项待处理`, result.filled > 0 ? 'success' : 'error');
          reload();
        })
        .catch((error: unknown) => {
          toast(describeError(error), 'error');
          apply.removeAttribute('disabled');
        });
    });

    panels.push(
      el('div', { class: 'card record-binding' }, [
        el('h3', { text: `${section?.label ?? group.section}：这一组字段对应哪一条经历？` }),
        el('p', { class: 'muted', text: `涉及 ${group.labels.length} 个字段：${[...new Set(group.labels)].join('、')}` }),
        el('p', { class: 'muted', text: '网页上的位置比履历里的条数少时，扩展不会替你猜。选定后整组一次填写。' }),
        el('div', { class: 'toolbar' }, [select, apply]),
      ]),
    );
  }
  return panels;
}

/** 页面预置了比履历更多的空记录时，把整组重复字段合并成一个可行动提示。 */
function excessEmptyRecordPanels(snapshot: RunSnapshot, visible: FieldResult[]): HTMLElement[] {
  const excess = new Set(snapshot.excessEmptyRecordInstanceIds);
  const groups = new Map<string, { section: string; fields: FieldResult[] }>();
  for (const field of visible) {
    const descriptor = snapshot.descriptors.find((item) => item.fieldId === field.fieldId);
    const instanceId = descriptor?.recordInstanceId;
    if (!instanceId || !excess.has(instanceId)) continue;
    const group = groups.get(instanceId);
    if (group) group.fields.push(field);
    else groups.set(instanceId, { section: field.section, fields: [field] });
  }
  return [...groups.values()].map((group) => {
    const section = getSection(group.section as never);
    const labels = [...new Set(group.fields.map((field) => field.label))];
    return el('div', { class: 'field-row outcome-pending' }, [
      el('div', { class: 'field-head' }, [
        el('span', { class: 'badge badge-pending', text: '空白记录' }),
        el('strong', { class: 'field-label', text: `${section?.label ?? group.section} · 多余记录` }),
        el('span', { class: 'field-meta', text: `${group.fields.length} 个字段已折叠` }),
      ]),
      el('div', {
        class: 'field-reason',
        text: `履历中没有对应经历。网页字段：${labels.join('、')}。请在网页删除这条空记录，或手动补充后重新扫描。`,
      }),
    ]);
  });
}

export async function renderReview(runId: string, state: StateView, reload: () => void): Promise<void> {
  const host = byId('view-review');
  clear(host);

  let snapshot: RunSnapshot;
  try {
    snapshot = await send<RunSnapshot>('GET_RUN', { runId });
  } catch (error) {
    host.append(el('p', { class: 'empty', text: describeError(error) }));
    return;
  }

  const report = snapshot.report;
  const total = report.fields.length;
  host.append(
    el('div', { class: 'panel-head' }, [
      el('h2', { text: '填写结果' }),
      el('p', {
        class: 'muted',
        text: `运行 ${report.id.slice(0, 12)}… · ${report.origin}${report.routeKey} · 状态：${report.phase} · 模型调用 ${report.modelCalls} 次`,
      }),
    ]),
  );

  if (report.phase === 'planned') {
    host.append(
      el('p', { class: 'banner warn' }, [
        `这是一次扫描：还没有向网页写入任何内容。本轮可以自动填写 ${snapshot.planned} 项，`,
        '要真正填写请回到弹窗点「一键填写」。',
      ]),
    );
  }

  for (const panel of ambiguousRecordPanels(snapshot, state, reload)) host.append(panel);

  const filters = el('div', { class: 'filters' });
  const counts: Record<string, number> = { all: total, ...snapshot.summary };
  for (const [key, label] of Object.entries({ all: '全部', ...summaryLabels })) {
    const button = el('button', {
      type: 'button',
      class: `chip${filter === key ? ' chip-active' : ''}`,
      text: `${label} ${counts[key] ?? 0}`,
    });
    on(button, 'click', () => {
      filter = key;
      void renderReview(runId, state, reload);
    });
    filters.append(button);
  }
  host.append(filters);

  for (const note of snapshot.notes) host.append(el('p', { class: 'note', text: note }));

  // 按原因汇总：45 项待处理到底卡在哪，一眼看清。
  const reasonCounts = new Map<string, number>();
  for (const field of report.fields) {
    if (field.outcome !== 'pending' && field.outcome !== 'failed') continue;
    reasonCounts.set(field.reasonCode, (reasonCounts.get(field.reasonCode) ?? 0) + 1);
  }
  if (reasonCounts.size > 0) {
    const ranked = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]);
    const list = el('ul', { class: 'reason-summary' });
    for (const [code, count] of ranked) {
      list.append(el('li', { text: `${reasonLabels[code as ReasonCode] ?? code}：${count} 项` }));
    }
    host.append(el('div', { class: 'card' }, [el('h3', { text: '待处理原因分布' }), list]));
  }

  const list = el('div', { class: 'field-list' });
  const visible = report.fields.filter((field) => filter === 'all' || field.outcome === filter);
  if (visible.length === 0) {
    list.append(el('p', { class: 'empty', text: '这个筛选条件下没有字段。' }));
  }
  const excess = new Set(snapshot.excessEmptyRecordInstanceIds);
  for (const panel of excessEmptyRecordPanels(snapshot, visible)) list.append(panel);
  for (const field of visible) {
    const descriptor = snapshot.descriptors.find((item) => item.fieldId === field.fieldId);
    if (descriptor?.recordInstanceId && excess.has(descriptor.recordInstanceId)) continue;
    list.append(fieldRow(field, snapshot, state, reload));
  }
  host.append(list);

  if (snapshot.jobCandidate) {
    const candidate = snapshot.jobCandidate;
    const box = el('div', { class: 'card' }, [
      el('h3', { text: '岗位候选（需人工核对）' }),
      el('p', { text: `${candidate.company ?? '未识别公司'} · ${candidate.role ?? '未识别岗位'}` }),
    ]);
    const create = el('button', { type: 'button', class: 'primary', text: '用这些信息新建投递记录' });
    on(create, 'click', () => {
      const params = new URLSearchParams();
      if (candidate.company) params.set('company', candidate.company);
      if (candidate.role) params.set('role', candidate.role);
      if (candidate.location) params.set('location', candidate.location);
      if (candidate.sourceUrl) params.set('sourceUrl', candidate.sourceUrl);
      if (candidate.externalJobId) params.set('jobId', candidate.externalJobId);
      location.hash = `applications?${params.toString()}`;
    });
    box.append(create);
    host.append(box);
  }
}

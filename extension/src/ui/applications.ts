import { STATUS_LABELS, BLOCKER_LABELS, exportCsv, csvRowsToRecords } from '../background/applications';
import { parseCsvRows } from '../shared/csv';
import { formatTimestamp } from '../shared/dates';
import { buildCanonicalUrl, extractJobId, sanitizeUrl } from '../shared/urls';
import type { ApplicationRecord, ApplicationStatus } from '../shared/types';
import { byId, clear, describeError, downloadFile, el, on, send, toast, type StateView } from './common';

/** 投递记录：表格、筛选、新增/修改、重复提示、CSV 导入导出。 */

let search = '';
let statusFilter: string = 'all';

interface UpsertReply {
  saved: boolean;
  id?: string;
  duplicate?: { id: string; company: string; role: string; status: ApplicationStatus };
  similar?: Array<{ id: string; company: string; role: string }>;
  confidence?: 'strong' | 'weak';
}

function statusSelect(current: ApplicationStatus, allowed: ApplicationStatus[]): HTMLSelectElement {
  const select = el('select');
  for (const status of allowed) {
    select.append(el('option', { value: status, text: STATUS_LABELS[status] }));
  }
  select.value = current;
  return select;
}

function recordForm(state: StateView, existing: ApplicationRecord | null, prefill: URLSearchParams | null, reload: () => void): HTMLElement {
  const card = el('section', { class: 'card' }, [el('h3', { text: existing ? '修改投递记录' : '新增投递记录' })]);

  const company = el('input', { type: 'text', id: 'app-company', value: existing?.company ?? prefill?.get('company') ?? '' });
  const role = el('input', { type: 'text', id: 'app-role', value: existing?.role ?? prefill?.get('role') ?? '' });
  const locationInput = el('input', { type: 'text', id: 'app-location', value: existing?.location ?? prefill?.get('location') ?? '' });
  const url = el('input', { type: 'text', id: 'app-url', value: existing?.sourceUrl ?? prefill?.get('sourceUrl') ?? '' });
  const jobId = el('input', { type: 'text', id: 'app-jobid', value: existing?.externalJobId ?? prefill?.get('jobId') ?? '' });
  const nextAction = el('input', { type: 'text', id: 'app-next', value: existing?.nextAction ?? '' });
  const notes = el('textarea', { id: 'app-notes', rows: 2 });
  notes.value = existing?.notes ?? '';

  const initialStatuses: ApplicationStatus[] = ['planned', 'filling', 'ready'];
  const allowed = existing
    ? ([...new Set([existing.status, ...initialStatuses, 'closed', 'assessment', 'interview', 'offer', 'rejected'])] as ApplicationStatus[])
    : initialStatuses;
  const status = statusSelect(existing?.status ?? 'planned', allowed);
  status.id = 'app-status';

  const blocker = el('select', { id: 'app-blocker' });
  for (const [value, label] of Object.entries(BLOCKER_LABELS)) blocker.append(el('option', { value, text: label }));
  blocker.value = existing?.blocker ?? 'none';

  const profileSelect = el('select', { id: 'app-profile' });
  profileSelect.append(el('option', { value: '', text: '不关联履历版本' }));
  for (const profile of state.profiles) {
    profileSelect.append(el('option', { value: profile.profileVersionId, text: `${profile.name}（${profile.profileVersionId}）` }));
  }
  profileSelect.value = existing?.profileVersionId ?? state.activeProfileVersionId ?? '';

  const field = (label: string, control: HTMLElement) => el('div', { class: 'form-field' }, [el('label', { text: label }), control]);
  card.append(
    field('公司', company),
    field('岗位', role),
    field('地点', locationInput),
    field('岗位链接', url),
    field('岗位 ID', jobId),
    field('状态', status),
    field('阻塞原因', blocker),
    field('使用的履历版本', profileSelect),
    field('下一步', nextAction),
    field('备注', notes),
  );

  const hint = el('div', { class: 'preview' });
  card.append(hint);

  const save = el('button', { type: 'button', class: 'primary', id: 'btn-save-application', text: existing ? '保存修改' : '保存记录' });
  const submit = (allowDuplicate: boolean) => {
    const rawUrl = url.value.trim();
    const cleanUrl = rawUrl ? sanitizeUrl(rawUrl) : null;
    const canonical = rawUrl ? buildCanonicalUrl(rawUrl) : null;
    const payload = {
      record: {
        id: existing?.id ?? null,
        company: company.value.trim(),
        role: role.value.trim(),
        location: locationInput.value.trim() || null,
        sourceUrl: cleanUrl,
        canonicalUrl: canonical,
        externalJobId: jobId.value.trim() || (rawUrl ? extractJobId(rawUrl) : null),
        profileVersionId: profileSelect.value || null,
        status: status.value as ApplicationStatus,
        blocker: blocker.value,
        // dedupeKey、时间戳、提交证据与 timeline 由后台计算，界面不提交这些字段。
        appliedAt: null,
        nextAction: nextAction.value.trim() || null,
        notes: notes.value.trim() || null,
        submissionEvidence: null,
      },
      expectedRevision: state.revision,
      allowDuplicate,
    };
    if (!payload.record.company || !payload.record.role) {
      toast('公司和岗位都必须填写', 'error');
      return;
    }
    void send<UpsertReply>('UPSERT_APPLICATION', payload)
      .then((reply) => {
        clear(hint);
        if (!reply.saved && reply.duplicate) {
          hint.append(
            el('p', { class: 'warn', text: `已有相同岗位的记录：${reply.duplicate.company} / ${reply.duplicate.role}（${STATUS_LABELS[reply.duplicate.status]}）` }),
          );
          const openExisting = el('button', { type: 'button', class: 'ghost', text: '打开已有记录' });
          on(openExisting, 'click', () => {
            location.hash = `applications?edit=${reply.duplicate!.id}`;
            reload();
          });
          const forceNew = el('button', { type: 'button', class: 'ghost', id: 'btn-record-again', text: '记录新的申请' });
          on(forceNew, 'click', () => submit(true));
          hint.append(openExisting, forceNew);
          return;
        }
        if (reply.similar && reply.similar.length > 0) {
          hint.append(el('p', { class: 'warn', text: `另有 ${reply.similar.length} 条同公司同岗位的记录，请确认不是重复投递。` }));
        }
        if (reply.confidence === 'weak') {
          hint.append(el('p', { class: 'warn', text: '这条记录缺少岗位链接或岗位 ID，重复判断可能不准确。' }));
        }
        toast('投递记录已保存', 'success');
        reload();
      })
      .catch((error: unknown) => toast(describeError(error), 'error'));
  };
  on(save, 'click', () => submit(false));
  card.append(save);
  return card;
}

function recordRow(record: ApplicationRecord, state: StateView, reload: () => void): HTMLElement {
  const row = el('div', { class: 'record', 'data-app-id': record.id });
  row.append(
    el('div', { class: 'record-head' }, [
      el('strong', { text: `${record.company} · ${record.role}` }),
      el('span', { class: `badge badge-status`, text: STATUS_LABELS[record.status] }),
    ]),
  );
  row.append(
    el('p', {
      class: 'muted',
      text: `${record.location ?? '地点未填写'} · 更新于 ${formatTimestamp(record.updatedAt, state.settings.timezone)}${record.appliedAt ? ` · 投递于 ${formatTimestamp(record.appliedAt, state.settings.timezone)}` : ''}`,
    }),
  );
  if (record.nextAction) row.append(el('p', { text: `下一步：${record.nextAction}` }));
  if (record.blocker !== 'none') row.append(el('p', { class: 'warn', text: `阻塞：${BLOCKER_LABELS[record.blocker]}` }));
  if (record.submissionEvidence) {
    row.append(
      el('p', {
        class: 'muted',
        text: `提交证据：${record.submissionEvidence.kind === 'user-confirmed' ? '用户确认看到成功提示' : '历史导入声明（未由扩展验证）'}`,
      }),
    );
  }

  const buttons = el('div', { class: 'record-buttons' });

  if (record.status !== 'applied' && !record.submissionEvidence) {
    const confirm = el('button', { type: 'button', class: 'tiny', 'data-action': 'confirm-submitted', text: '我已手动提交并看到成功提示' });
    on(confirm, 'click', () => {
      void send('CONFIRM_SUBMITTED', {
        recordId: record.id,
        successSeen: true,
        appliedAt: new Date().toISOString(),
        note: null,
        expectedRevision: state.revision,
      })
        .then(() => {
          toast('已记录为「已投递」', 'success');
          reload();
        })
        .catch((error: unknown) => toast(describeError(error), 'error'));
    });
    buttons.append(confirm);
  }

  const edit = el('button', { type: 'button', class: 'tiny', text: '修改' });
  on(edit, 'click', () => {
    location.hash = `applications?edit=${record.id}`;
    reload();
  });
  buttons.append(edit);

  const advance = el('select', { class: 'tiny', 'aria-label': '更改状态' });
  advance.append(el('option', { value: '', text: '更改状态…' }));
  for (const [value, label] of Object.entries(STATUS_LABELS)) {
    if (value === record.status || value === 'applied') continue;
    advance.append(el('option', { value, text: label }));
  }
  on(advance, 'change', () => {
    if (!advance.value) return;
    const next = advance.value as ApplicationStatus;
    const reason = window.prompt('这次状态变更的原因（回退已投递记录时必填）', '') ?? '';
    void send('SET_APPLICATION_STATUS', {
      recordId: record.id,
      status: next,
      blocker: record.blocker,
      reason: reason.trim() || null,
      expectedRevision: state.revision,
    })
      .then(() => {
        toast('状态已更新', 'success');
        reload();
      })
      .catch((error: unknown) => {
        toast(describeError(error), 'error');
        advance.value = '';
      });
  });
  buttons.append(advance);

  row.append(buttons);
  return row;
}

export function renderApplications(state: StateView, reload: () => void): void {
  const host = byId('view-applications');
  clear(host);

  const [, query] = location.hash.split('?');
  const params = new URLSearchParams(query ?? '');
  const editId = params.get('edit');
  const editing = editId ? state.applications.find((record) => record.id === editId) ?? null : null;

  host.append(
    el('div', { class: 'panel-head' }, [
      el('h2', { text: '投递记录' }),
      el('p', { class: 'muted', text: '插件不会自动提交申请。只有你确认在网站上看到成功提示后，记录才会变为「已投递」。' }),
    ]),
  );

  host.append(recordForm(state, editing, params, reload));

  const tools = el('section', { class: 'card' }, [el('h3', { text: '筛选与导入导出' })]);
  const searchInput = el('input', { type: 'search', id: 'app-search', placeholder: '搜索公司或岗位', value: search });
  on(searchInput, 'input', () => {
    search = searchInput.value;
    renderApplications(state, reload);
  });
  const statusPicker = el('select', { id: 'app-status-filter' });
  statusPicker.append(el('option', { value: 'all', text: '全部状态' }));
  for (const [value, label] of Object.entries(STATUS_LABELS)) statusPicker.append(el('option', { value, text: label }));
  statusPicker.value = statusFilter;
  on(statusPicker, 'change', () => {
    statusFilter = statusPicker.value;
    renderApplications(state, reload);
  });
  tools.append(el('div', { class: 'toolbar' }, [searchInput, statusPicker]));

  const exportButton = el('button', { type: 'button', class: 'ghost', id: 'btn-export-csv', text: '导出 CSV' });
  on(exportButton, 'click', () => {
    downloadFile(`applykit-applications-${Date.now()}.csv`, exportCsv(state.applications), 'text/csv');
    toast('已导出 CSV', 'success');
  });

  const csvInput = el('input', { type: 'file', accept: '.csv,text/csv', id: 'csv-file' });
  const strategy = el('select', { id: 'csv-strategy' });
  for (const [value, label] of [
    ['skip-identical', '跳过冲突项'],
    ['append-as-new', '冲突项作为新申请追加'],
    ['replace-by-id', '按 ID 覆盖冲突项'],
  ]) {
    strategy.append(el('option', { value: value!, text: label! }));
  }
  const importButton = el('button', { type: 'button', class: 'primary', id: 'btn-import-csv', text: '导入 CSV' });
  const importPreview = el('div', { class: 'preview' });
  on(importButton, 'click', () => {
    const file = csvInput.files?.[0];
    if (!file) {
      toast('请先选择 CSV 文件', 'error');
      return;
    }
    void importCsv(file, state, strategy.value, importPreview, reload);
  });
  tools.append(el('div', { class: 'toolbar' }, [exportButton, csvInput, strategy, importButton]), importPreview);
  host.append(tools);

  const filtered = state.applications.filter((record) => {
    if (statusFilter !== 'all' && record.status !== statusFilter) return false;
    if (!search.trim()) return true;
    const needle = search.trim().toLowerCase();
    return (
      record.company.toLowerCase().includes(needle) ||
      record.role.toLowerCase().includes(needle) ||
      (record.location ?? '').toLowerCase().includes(needle)
    );
  });

  const list = el('section', { class: 'card', id: 'application-list' }, [
    el('h3', { text: `记录（${filtered.length}/${state.applications.length}）` }),
  ]);
  if (filtered.length === 0) list.append(el('p', { class: 'empty', text: '没有符合条件的记录。' }));
  for (const record of filtered) list.append(recordRow(record, state, reload));
  host.append(list);
}

async function importCsv(
  file: File,
  state: StateView,
  strategy: string,
  preview: HTMLElement,
  reload: () => void,
): Promise<void> {
  clear(preview);
  const text = await file.text();
  const parsed = parseCsvRows(text);
  if (parsed.rows.length === 0) {
    preview.append(el('p', { class: 'error', text: '没有可导入的行，已有数据没有改变。' }));
    for (const issue of parsed.errors) preview.append(el('p', { class: 'error', text: `第 ${issue.line} 行：${issue.message}` }));
    return;
  }
  const converted = await csvRowsToRecords(parsed.rows, new Date().toISOString());
  preview.append(el('p', { text: `解析出 ${converted.records.length} 条记录，${converted.issues.length} 条有问题。` }));
  for (const issue of converted.issues) preview.append(el('p', { class: 'error', text: `第 ${issue.line} 行：${issue.message}` }));
  const submitted = converted.records.filter((record) => record.appliedAt !== null);
  if (submitted.length > 0) {
    preview.append(
      el('p', {
        class: 'warn',
        text: `其中 ${submitted.length} 条声明已投递。导入后会标记为「历史导入声明」，表示导入者的说法，不是扩展亲自验证的结果。`,
      }),
    );
  }

  const confirm = el('button', { type: 'button', class: 'primary', id: 'btn-confirm-csv', text: '确认导入' });
  on(confirm, 'click', () => {
    void send<{ added: number; skipped: number; replaced: number }>('IMPORT_APPLICATIONS', {
      records: converted.records,
      strategy,
      expectedRevision: state.revision,
    })
      .then((result) => {
        toast(`导入完成：新增 ${result.added}，跳过 ${result.skipped}，覆盖 ${result.replaced}`, 'success');
        reload();
      })
      .catch((error: unknown) => toast(describeError(error), 'error'));
  });
  preview.append(confirm);
}

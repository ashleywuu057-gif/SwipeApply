import { byId, clear, describeError, el, getState, on, send, type StateView } from './common';
import { summaryLabels } from './review';

/** 工具栏弹窗：当前履历、当前网站、扫描、一键填写、停止、上次摘要。 */

interface TargetTab {
  tabId: number | null;
  url: string | null;
  title: string | null;
  injectable: boolean;
  message: string | null;
}

interface PrepareRunOutput {
  runId: string;
  phase: string;
  scan: {
    origin: string;
    routeKey: string;
    pageTitle: string;
    fieldCount: number;
    adapterId: string | null;
    truncated: boolean;
    truncationReason: string | null;
    jobCandidate: { company: string | null; role: string | null } | null;
  };
  planned: number;
  pending: number;
  reused: boolean;
  notes: string[];
}

interface RunSnapshot {
  report: { id: string; phase: string; fields: Array<{ outcome: string }>; finishedAt: string | null };
  planned: number;
  summary: Record<string, number>;
  notes: string[];
}

const isScan = (snapshot: RunSnapshot) => snapshot.report.phase === 'planned';

let state: StateView | null = null;
let target: TargetTab | null = null;
let currentRunId: string | null = null;
let pollTimer: number | null = null;

async function refresh(): Promise<void> {
  state = await getState();
  target = await send<TargetTab>('GET_TARGET_TAB');
  render();
}

function activeProfileName(): string {
  if (!state) return '加载中…';
  const profile = state.profiles.find((entry) => entry.profileVersionId === state!.activeProfileVersionId);
  if (!profile) return '尚未导入履历';
  const flag = profile.source.status === 'fictional' ? '（虚构演示资料）' : '';
  return `${profile.name}${flag}`;
}

function render(): void {
  const profileNode = byId('current-profile');
  profileNode.textContent = activeProfileName();

  const siteNode = byId('current-site');
  if (!target || !target.tabId) {
    siteNode.textContent = target?.message ?? '无法读取当前标签页';
  } else {
    let host = target.url ?? '';
    try {
      host = new URL(target.url ?? '').host;
    } catch {
      /* 保留原始文本 */
    }
    siteNode.textContent = target.injectable ? host : (target.message ?? '这个页面不支持填写');
  }

  const canRun = Boolean(state?.activeProfileVersionId) && Boolean(target?.injectable);
  (byId('btn-scan') as HTMLButtonElement).disabled = !canRun;
  (byId('btn-fill') as HTMLButtonElement).disabled = !canRun;
  (byId('btn-stop') as HTMLButtonElement).disabled = currentRunId === null;

  if (state?.unreadable) {
    byId('status-line').textContent = `本地数据无法读取：${state.unreadable.reason}`;
  }
}

function renderSummary(snapshot: RunSnapshot): void {
  const host = byId('summary');
  clear(host);
  const summary = snapshot.summary;
  const total = Object.values(summary).reduce((sum, value) => sum + value, 0);
  host.append(el('div', { class: 'summary-total', text: `本轮共 ${total} 个字段` }));
  if (isScan(snapshot)) {
    // 扫描不写入任何内容，摘要里必须说清楚，否则「已填写 0」会被误读成识别失败。
    host.append(
      el('p', { class: 'note', text: `扫描完成：可以自动填写 ${snapshot.planned} 项，点「一键填写」才会真正写入。` }),
    );
  }
  const list = el('ul', { class: 'summary-list' });
  for (const [key, label] of Object.entries(summaryLabels)) {
    const count = summary[key] ?? 0;
    list.append(el('li', {}, [el('span', { class: `dot dot-${key}` }), `${label}：${count}`]));
  }
  host.append(list);
  for (const note of snapshot.notes) host.append(el('p', { class: 'note', text: note }));

  const link = el('button', { class: 'link', type: 'button', text: '查看详情并处理待处理项' });
  on(link, 'click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`app.html#review/${snapshot.report.id}`) });
  });
  host.append(link);

  // jobprep：没填上的你手动补好后，可以让插件记住，下次自动填
  const leftover = (summary['pending'] ?? 0) + (summary['failed'] ?? 0);
  if (!isScan(snapshot) && snapshot.report.finishedAt && leftover > 0) {
    const box = el('div', { class: 'remember-box', id: 'remember-box' });
    box.append(el('p', { class: 'note', text: `还有 ${leftover} 项没填上：在网页上手动补好后，点下面的按钮，插件会记住，下次遇到同名字段自动填。` }));
    const btn = el('button', { class: 'ghost', type: 'button', text: '记住我补填的内容' });
    on(btn, 'click', () => void captureManual(snapshot.report.id));
    box.append(btn);
    host.append(box);
  }
}

interface ManualItem {
  section: string;
  label: string;
  recordKey: string | null;
  value: string;
  suggested: boolean;
  sensitive: boolean;
}

/** 读出你手动补填的内容，列成清单勾选后保存 */
async function captureManual(runId: string): Promise<void> {
  const box = byId('remember-box');
  clear(box);
  box.append(el('p', { class: 'note', text: '正在读取你补填的内容…' }));
  try {
    const result = await send<{ items: ManualItem[]; origin: string }>('CAPTURE_MANUAL', { runId });
    clear(box);
    if (result.items.length === 0) {
      box.append(el('p', { class: 'note', text: '没有读到新补填的内容：先在网页上把没填上的字段填好，再点一次。日期、敏感信息和附件不会记。' }));
      return;
    }
    box.append(el('p', { class: 'note', text: '勾选要记住的。每个岗位不一样的（推荐方式、意向城市）和敏感信息（婚姻状况等）默认不勾，需要你自己决定；证件号、银行卡永远不记。' }));
    const checks: Array<{ input: HTMLInputElement; item: ManualItem }> = [];
    for (const item of result.items) {
      const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
      input.checked = item.suggested;
      checks.push({ input, item });
      const where = item.recordKey ? `（${item.recordKey}）` : '';
      box.append(el('label', { class: 'remember-item' }, [
        input, ` ${item.label}${where}：`, el('b', { text: item.value.slice(0, 60) }),
        item.sensitive ? el('span', { class: 'remember-sensitive', text: ' 敏感' }) : null,
      ]));
    }
    const save = el('button', { class: 'primary', type: 'button', text: '记住勾选的' });
    on(save, 'click', () => {
      const items = checks.filter((c) => c.input.checked).map(({ item }) => ({
        section: item.section, label: item.label, recordKey: item.recordKey, value: item.value,
      }));
      if (items.length === 0) return;
      void send<{ saved: number; total: number }>('SAVE_REMEMBERED', { origin: result.origin, items })
        .then((r) => {
          clear(box);
          box.append(el('p', { class: 'note', text: `已记住 ${r.saved} 项，下次遇到同名字段会自动填。可以在「履历管理 → 规则」里查看和删除。` }));
        })
        .catch((error: unknown) => {
          byId('status-line').textContent = describeError(error);
        });
    });
    box.append(save);
  } catch (error) {
    clear(box);
    box.append(el('p', { class: 'note', text: describeError(error) }));
  }
}

async function pollRun(runId: string): Promise<void> {
  try {
    const snapshot = await send<RunSnapshot>('GET_RUN', { runId });
    renderSummary(snapshot);
    byId('status-line').textContent = phaseText(snapshot.report.phase);
    if (snapshot.report.finishedAt) {
      currentRunId = null;
      if (pollTimer !== null) window.clearInterval(pollTimer);
      pollTimer = null;
      render();
    }
  } catch (error) {
    byId('status-line').textContent = describeError(error);
  }
}

function phaseText(phase: string): string {
  switch (phase) {
    case 'filling':
      return '正在填写…（可以关闭弹窗，填写会继续）';
    case 'completed':
      return '本轮填写结束';
    case 'cancelled':
      return '已停止，保留已填内容';
    case 'interrupted':
      return '页面发生变化，本轮已中断';
    case 'planned':
      return '扫描完成';
    default:
      return phase;
  }
}

async function startRun(mode: 'scan' | 'fill'): Promise<void> {
  if (!state?.activeProfileVersionId || !target?.tabId) return;
  byId('status-line').textContent = mode === 'scan' ? '正在扫描页面…' : '正在准备填写…';
  try {
    const result = await send<PrepareRunOutput>('PREPARE_RUN', {
      targetTabId: target.tabId,
      profileVersionId: state.activeProfileVersionId,
      mode,
      applicationId: null,
    });
    currentRunId = result.runId;
    const lines = [`页面识别到 ${result.scan.fieldCount} 个字段，计划填写 ${result.planned} 个`];
    if (result.reused) lines.push('这一页已有正在进行的填写');
    if (result.scan.jobCandidate?.company || result.scan.jobCandidate?.role) {
      lines.push(`岗位候选：${result.scan.jobCandidate.company ?? '未知公司'} / ${result.scan.jobCandidate.role ?? '未知岗位'}（需人工核对）`);
    }
    for (const note of result.notes) lines.push(note);
    byId('status-line').textContent = lines.join('；');
    render();

    await pollRun(result.runId);
    if (mode === 'fill') {
      pollTimer = window.setInterval(() => void pollRun(result.runId), 400);
    }
  } catch (error) {
    byId('status-line').textContent = describeError(error);
  }
}

/** jobprep：从本机的SwipeApply同步履历；当前网申页对得上岗位时，用这个岗位定制过的简历 */
async function syncJobprep(): Promise<void> {
  if (!state) return;
  byId('status-line').textContent = '正在从SwipeApply同步履历…';
  try {
    const result = await send<{ outcome: { kind: string }; name: string; job: { company: string; title: string } | null }>('SYNC_JOBPREP', {
      targetUrl: target?.url ?? null,
      expectedRevision: state.revision,
    });
    const how = result.outcome.kind === 'idempotent' ? '已是最新' : '已同步';
    byId('status-line').textContent = result.job
      ? `${how}：用「${result.job.company} ${result.job.title}」的定制简历`
      : `${how}：SwipeApply的通用履历（这个页面没对上岗位库里的岗位）`;
    await refresh();
  } catch (error) {
    byId('status-line').textContent = describeError(error);
  }
}

function bind(): void {
  on(byId('btn-sync-jobprep'), 'click', () => void syncJobprep());
  on(byId('btn-scan'), 'click', () => void startRun('scan'));
  on(byId('btn-fill'), 'click', () => void startRun('fill'));
  on(byId('btn-stop'), 'click', () => {
    if (!currentRunId) return;
    void send('CANCEL_RUN', { runId: currentRunId })
      .then(() => {
        byId('status-line').textContent = '已请求停止，当前动作完成后生效';
      })
      .catch((error: unknown) => {
        byId('status-line').textContent = describeError(error);
      });
  });
  on(byId('link-profiles'), 'click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('app.html#profiles') });
  });
  on(byId('link-applications'), 'click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('app.html#applications') });
  });
}

bind();
void refresh().catch((error: unknown) => {
  byId('status-line').textContent = describeError(error);
});

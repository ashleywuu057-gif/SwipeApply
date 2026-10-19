import { byId, describeError, el, getState, on, toast, type StateView } from './common';
import { renderApplications } from './applications';
import { renderBackup } from './import-export';
import { renderEditorView, renderProfiles } from './profile-editor';
import { renderReview } from './review';
import { renderRules } from './rules';

/** 工作台路由：#profiles / #editor / #review/<runId> / #applications / #rules / #backup */

const VIEWS = ['profiles', 'editor', 'review', 'applications', 'rules', 'backup'] as const;
type ViewName = (typeof VIEWS)[number];

let state: StateView | null = null;

function currentRoute(): { view: ViewName; param: string | null } {
  const raw = location.hash.replace(/^#/, '');
  const [path] = raw.split('?');
  const [view, param] = (path ?? '').split('/');
  const name = (VIEWS as readonly string[]).includes(view ?? '') ? (view as ViewName) : 'profiles';
  return { view: name, param: param ?? null };
}

function showView(view: ViewName): void {
  for (const name of VIEWS) {
    const node = document.getElementById(`view-${name}`);
    if (node) node.hidden = name !== view;
    const tab = document.getElementById(`tab-${name}`);
    if (tab) tab.setAttribute('aria-current', name === view ? 'page' : 'false');
  }
}

async function reload(): Promise<void> {
  state = await getState();
  if (state.unreadable) {
    const banner = byId('data-warning');
    banner.hidden = false;
    banner.textContent = `本地数据无法读取：${state.unreadable.reason}。已进入只读保护，不会清空任何数据。`;
  } else {
    byId('data-warning').hidden = true;
  }
  await route();
}

async function route(): Promise<void> {
  if (!state) return;
  const { view, param } = currentRoute();
  showView(view);
  switch (view) {
    case 'profiles':
      renderProfiles(state, () => void reload());
      break;
    case 'editor':
      renderEditorView(state);
      break;
    case 'review':
      if (param) await renderReview(param, state, () => void reload());
      else byId('view-review').textContent = '请先在弹窗中执行一次扫描或填写。';
      break;
    case 'applications':
      renderApplications(state, () => void reload());
      break;
    case 'rules':
      renderRules(state, () => void reload());
      break;
    case 'backup':
      renderBackup(state, () => void reload());
      break;
  }
}

function bindTabs(): void {
  for (const name of VIEWS) {
    const tab = document.getElementById(`tab-${name}`);
    if (!tab) continue;
    on(tab, 'click', () => {
      location.hash = name;
    });
  }
  // 切换页签时重新读取状态，避免显示上一次加载时的旧数据。
  window.addEventListener('hashchange', () => void reload());
  window.addEventListener('applykit-reload', () => void reload());
}

bindTabs();
void reload().catch((error: unknown) => {
  const host = byId('view-profiles');
  host.append(el('p', { class: 'error', text: describeError(error) }));
  toast(describeError(error), 'error');
});

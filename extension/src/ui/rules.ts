import { getSection, getCatalogField } from '../shared/field-catalog';
import { formatTimestamp } from '../shared/dates';
import { byId, clear, describeError, el, on, send, toast, type StateView } from './common';

/** 修正规则列表：网站、表单结构、网页标签、源字段、更新时间；可删除。 */

function selectorText(selector: StateView['mappings'][number]['recordSelector']): string {
  switch (selector.kind) {
    case 'single':
      return '单值字段';
    case 'degree':
      return `按学历层级：${selector.level}`;
    case 'record':
      return `指定经历：${selector.recordId}`;
  }
}

export function renderRules(state: StateView, reload: () => void): void {
  const host = byId('view-rules');
  clear(host);

  host.append(
    el('div', { class: 'panel-head' }, [
      el('h2', { text: '字段对应规则' }),
      el('p', { class: 'muted', text: '规则只保存「网页字段 ↔ 履历字段」的对应关系，不保存任何具体内容。结构变化后规则会自动失效。' }),
    ]),
  );

  const list = el('section', { class: 'card', id: 'rule-list' }, [
    el('h3', { text: `已保存 ${state.mappings.length} 条规则` }),
  ]);
  if (state.mappings.length === 0) {
    list.append(el('p', { class: 'empty', text: '还没有规则。在结果页把一个陌生字段对应到履历字段并勾选「记住」即可创建。' }));
  }

  for (const rule of state.mappings) {
    const section = getSection(rule.section);
    const field = getCatalogField(rule.section, rule.sourceField);
    const row = el('div', { class: 'record', 'data-rule-id': rule.id }, [
      el('div', { class: 'record-head' }, [
        el('strong', { text: rule.fieldLabel }),
        el('span', { class: 'field-meta', text: `${rule.origin}${rule.routeKey}` }),
      ]),
      el('p', {
        text: `对应到：${section?.label ?? rule.section} / ${field?.label ?? rule.sourceField} · ${selectorText(rule.recordSelector)}`,
      }),
      el('p', {
        class: 'muted',
        text: `控件：${rule.controlKind} · 表单结构 ${rule.formFingerprint} · 更新于 ${formatTimestamp(rule.updatedAt, state.settings.timezone)}`,
      }),
    ]);
    const remove = el('button', { type: 'button', class: 'tiny', text: '删除规则' });
    on(remove, 'click', () => {
      void send('DELETE_MAPPING', { mappingId: rule.id, expectedRevision: state.revision })
        .then(() => {
          toast('规则已删除', 'success');
          reload();
        })
        .catch((error: unknown) => toast(describeError(error), 'error'));
    });
    row.append(el('div', { class: 'record-buttons' }, [remove]));
    list.append(row);
  }
  host.append(list);
  host.append(renderRemembered(state));
}

interface Remembered {
  id: string;
  section: string;
  displayLabel: string;
  recordKey: string | null;
  value: string;
  savedAt: string;
  origin: string;
}

/** jobprep：你手动补填后勾选记住的内容。和上面的规则不同，这里保存的是具体的值，只存在本机插件里。 */
function renderRemembered(state: StateView): HTMLElement {
  const card = el('section', { class: 'card', id: 'remembered-list' }, [
    el('h3', { text: '记住的补填内容' }),
    el('p', { class: 'muted', text: '填写后你手动补上、再点「记住我补填的内容」勾选保存的。下次任何网站遇到同名字段（经历类还要是同一段经历）会自动填。只存在本机插件里。' }),
  ]);
  const body = el('div', {});
  card.append(body);
  const load = () => {
    void send<{ items: Remembered[] }>('LIST_REMEMBERED', {})
      .then(({ items }) => {
        clear(body);
        if (items.length === 0) {
          body.append(el('p', { class: 'empty', text: '还没有记住的内容。' }));
          return;
        }
        for (const item of [...items].reverse()) {
          const section = getSection(item.section as Parameters<typeof getSection>[0]);
          const remove = el('button', { type: 'button', class: 'tiny', text: '删除' });
          on(remove, 'click', () => {
            void send('DELETE_REMEMBERED', { id: item.id })
              .then(() => {
                toast('已删除', 'success');
                load();
              })
              .catch((error: unknown) => toast(describeError(error), 'error'));
          });
          body.append(el('div', { class: 'record', 'data-remembered-id': item.id }, [
            el('div', { class: 'record-head' }, [
              el('strong', { text: `${item.displayLabel}：${item.value}` }),
              el('span', { class: 'field-meta', text: `${section?.label ?? item.section}${item.recordKey ? ` · ${item.recordKey}` : ''}` }),
            ]),
            el('p', { class: 'muted', text: `在 ${item.origin} 记下 · ${formatTimestamp(item.savedAt, state.settings.timezone)}` }),
            el('div', { class: 'record-buttons' }, [remove]),
          ]));
        }
      })
      .catch((error: unknown) => {
        clear(body);
        body.append(el('p', { class: 'empty', text: describeError(error) }));
      });
  };
  load();
  return card;
}

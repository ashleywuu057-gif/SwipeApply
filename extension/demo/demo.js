/**
 * 演示页面自身的表单状态。
 * 这里维护的状态完全来自页面自己的 input/change 监听器，
 * 因此「只改视觉值、没有触发事件」的假成功会在这里暴露出来。
 */

const received = new Map();

function keyOf(element) {
  if (element.name) return element.name;
  if (element.id) return element.id;
  return element.tagName.toLowerCase();
}

function record(element) {
  const key = keyOf(element);
  if (element.type === 'checkbox') {
    received.set(key, element.checked ? 'true' : 'false');
  } else if (element.type === 'radio') {
    if (element.checked) received.set(key, element.value);
  } else {
    received.set(key, element.value);
  }
  renderState();
}

function renderState() {
  const host = document.getElementById('received-state');
  if (!host) return;
  const table = document.createElement('table');
  for (const [key, value] of [...received.entries()].sort()) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = key;
    const cell = document.createElement('td');
    cell.textContent = value === '' ? '(空)' : value;
    row.append(name, cell);
    table.append(row);
  }
  host.replaceChildren(table);
}

/** 供测试读取：页面自己认为收到的数据。 */
window.__demoReceived = () => Object.fromEntries(received.entries());

function bind(root = document) {
  for (const element of root.querySelectorAll('input, select, textarea')) {
    if (element.dataset.demoBound === '1') continue;
    element.dataset.demoBound = '1';
    element.addEventListener('input', () => record(element));
    element.addEventListener('change', () => record(element));
  }
}

/** 新增记录后重新绑定，保证新字段也进入页面状态。 */
const observer = new MutationObserver(() => bind());

/* ------------------------- 异步 combobox（ARIA） ------------------------- */

function setupComboboxes() {
  for (const wrap of document.querySelectorAll('[data-demo-combobox]')) {
    const input = wrap.querySelector('input[role="combobox"]');
    const list = wrap.querySelector('[role="listbox"]');
    if (!input || !list) continue;
    const options = JSON.parse(wrap.dataset.demoOptions || '[]');

    const open = () => {
      if (input.getAttribute('aria-expanded') === 'true') return;
      input.setAttribute('aria-expanded', 'true');
      list.replaceChildren();
      list.hidden = false;
      // 选项异步出现，模拟远程加载。
      setTimeout(() => {
        for (const option of options) {
          const item = document.createElement('li');
          item.setAttribute('role', 'option');
          item.id = `${list.id}-${option}`;
          item.textContent = option;
          item.addEventListener('click', () => {
            input.value = option;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            list.hidden = true;
            input.setAttribute('aria-expanded', 'false');
          });
          list.append(item);
        }
      }, 180);
    };

    input.addEventListener('click', open);
    input.addEventListener('focus', open);
    document.addEventListener('click', (event) => {
      if (!wrap.contains(event.target)) {
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
      }
    });
  }
}

/* ------------------- 自定义下拉（复刻国内 ATS 的形态） ------------------- */

/**
 * 没有任何 ARIA：点开输入框才把选项渲染进同一个 Dropdown 容器里，
 * 选中后由页面自己把值写回 input 并派发事件——和 Moka 的行为一致。
 * 只有真正点中选项才算选择；直接往 input 里写文本不会被这里接受。
 */
function setupCustomSelects() {
  for (const box of document.querySelectorAll('[data-demo-select]')) {
    const input = box.querySelector('input');
    if (!input) continue;
    const options = JSON.parse(box.dataset.demoOptions || '[]');
    const searchable = box.hasAttribute('data-demo-searchable');
    let confirmed = box.dataset.demoValue || '';

    const close = () => {
      confirmed = box.dataset.demoValue || '';
      box.querySelector('.sd-Dropdown-dropdown-GmACl')?.remove();
      // 没有确认选择就离开时，页面把输入框恢复成已确认的值（搜索文字不算数）。
      if (input.value !== confirmed) {
        input.value = confirmed;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };

    const render = () => {
      box.querySelector('.sd-Dropdown-dropdown-GmACl')?.remove();
      const keyword = searchable ? input.value.trim() : '';
      const visible = keyword ? options.filter((o) => o.includes(keyword)) : searchable ? [] : options;

      const wrap = document.createElement('span');
      const menu = document.createElement('div');
      menu.className = 'sd-Dropdown-dropdown-GmACl';
      const content = document.createElement('div');
      content.className = 'sd-Menu-content-bDquM';
      for (const option of visible) {
        const item = document.createElement('div');
        item.className = 'sd-Menu-content-item-3BOO1';
        // Moka 的年月菜单没有 option-label，只在 Menu-content-item 内放普通文本节点。
        // 其他下拉仍保留 option-label，两个真实变体都要覆盖。
        const label = document.createElement(input.placeholder === '年' || input.placeholder === '月' ? 'span' : 'div');
        if (input.placeholder !== '年' && input.placeholder !== '月') {
          label.className = 'option-label-p2B4XVc4Pn';
        }
        label.textContent = option;
        item.append(label);
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          confirmed = option;
          box.dataset.demoValue = option;
          input.value = option;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          box.querySelector('.sd-Dropdown-dropdown-GmACl')?.remove();
        });
        content.append(item);
      }
      menu.append(content);
      wrap.append(menu);
      box.append(wrap);
    };

    // 选项是懒加载的：点开之后才出现。
    input.addEventListener('click', () => setTimeout(render, 150));
    if (searchable) input.addEventListener('input', () => setTimeout(render, 120));
    document.addEventListener('mousedown', (event) => {
      if (!box.contains(event.target)) close();
    });
  }
}

/* --------------------------- 异步校验测试分支 --------------------------- */

function setupAsyncValidation() {
  const toggle = document.getElementById('demo-async-invalid');
  const email = document.getElementById('email');
  if (!toggle || !email) return;
  const errorNode = document.getElementById('email-error');
  email.addEventListener('change', () => {
    setTimeout(() => {
      if (toggle.checked && email.value.trim() !== '') {
        email.setAttribute('aria-invalid', 'true');
        if (errorNode) errorNode.textContent = '演示：这个邮箱域名未通过异步校验';
      } else {
        email.removeAttribute('aria-invalid');
        if (errorNode) errorNode.textContent = '';
      }
    }, 120);
  });
}

/* ------------------------------ 新增项目 ------------------------------ */

let projectCount = 1;

function setupAddProject() {
  const button = document.querySelector('button[data-applykit-add="projects"]');
  if (!button) return;
  const host = document.getElementById('project-records');
  button.addEventListener('click', () => {
    projectCount += 1;
    const index = projectCount;
    const record = document.createElement('div');
    record.className = 'record';

    const title = document.createElement('p');
    title.className = 'record-title';
    title.textContent = `项目 ${index}`;
    record.append(title);

    const fields = [
      ['项目名称', `project-name-${index}`, 'text'],
      ['项目职责', `project-role-${index}`, 'text'],
      ['开始时间', `project-start-${index}`, 'month'],
      ['结束时间', `project-end-${index}`, 'text'],
    ];
    for (const [labelText, id, type] of fields) {
      const row = document.createElement('div');
      row.className = 'field';
      const label = document.createElement('label');
      label.setAttribute('for', id);
      label.textContent = labelText;
      const input = document.createElement('input');
      input.type = type;
      input.id = id;
      input.name = id;
      row.append(label, input);
      record.append(row);
    }
    host.append(record);
    bind(record);
  });
}

/* --------------------------- 提交（仅本地演示） --------------------------- */

function setupSubmit() {
  const button = document.getElementById('demo-submit');
  if (!button) return;
  button.addEventListener('click', () => {
    const box = document.getElementById('demo-success');
    if (!box) return;
    box.hidden = false;
    box.textContent = '演示提交成功：这是本地页面自己显示的提示，没有任何数据离开你的电脑。';
  });
}

/* ------------------------- edge-cases 的布局切换 ------------------------- */

function setupLayoutSwitch() {
  const button = document.getElementById('demo-switch-layout');
  if (button) {
    button.addEventListener('click', () => {
      const select = document.getElementById('degree-level');
      if (select) {
        // 改变选项集合，使已缓存的字段指纹失效。
        select.replaceChildren();
        for (const text of ['请选择', '专科及以下', '本科及以上']) {
          const option = document.createElement('option');
          option.value = text === '请选择' ? '' : text;
          option.textContent = text;
          select.append(option);
        }
      }
      const label = document.querySelector('label[for="contact-inbox"]');
      if (label) label.textContent = '联系信箱入口（新版）';
      const marker = document.getElementById('layout-state');
      if (marker) marker.textContent = '当前布局：新版';
    });
  }

  const routeButton = document.getElementById('demo-switch-route');
  if (routeButton) {
    routeButton.addEventListener('click', () => {
      location.hash = `#/step-${Date.now() % 100}`;
      const section = document.getElementById('replaceable-section');
      if (section) {
        const replacement = section.cloneNode(false);
        replacement.id = 'replaceable-section';
        const heading = document.createElement('legend');
        heading.textContent = '已替换的模块';
        replacement.append(heading);
        section.replaceWith(replacement);
      }
    });
  }
}

/* --------------------- 写入后替换自身节点的字段 --------------------- */

function setupSelfReplacingField() {
  const input = document.getElementById('project-name-1');
  if (!input) return;
  input.addEventListener('change', () => {
    if (input.dataset.replaced === '1') return;
    const clone = input.cloneNode(true);
    clone.value = input.value;
    clone.dataset.replaced = '1';
    clone.dataset.demoBound = '';
    input.replaceWith(clone);
    bind(clone.parentElement ?? document);
    record(clone);
  });
}

function setupReset() {
  const button = document.getElementById('demo-reset');
  if (!button) return;
  button.addEventListener('click', () => {
    for (const form of document.querySelectorAll('form')) form.reset();
    for (const box of document.querySelectorAll('[data-demo-select]')) {
      delete box.dataset.demoValue;
    }
    received.clear();
    renderState();
    const box = document.getElementById('demo-success');
    if (box) box.hidden = true;
  });
}

bind();
observer.observe(document.documentElement, { childList: true, subtree: true });
setupComboboxes();
setupCustomSelects();
setupAsyncValidation();
setupAddProject();
setupSubmit();
setupLayoutSwitch();
setupSelfReplacingField();
setupReset();
renderState();

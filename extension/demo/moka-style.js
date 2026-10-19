const received = new Map();

// 实页的四格年月范围由两个内层 span 分别包裹，不能把其中一对当成独立日期。
function setupDateRanges() {
  for (const range of document.querySelectorAll('.month-range-select')) {
    const boxes = [...range.querySelectorAll('[data-demo-select]')];
    for (const box of boxes) {
      const input = box.querySelector('input');
      const label = document.createElement('label');
      label.className = 'sd-Select-container-x';
      box.append(label);
      label.append(input);
    }
    for (let index = 0; index < boxes.length; index += 2) {
      const pair = document.createElement('span');
      boxes[index].before(pair);
      pair.append(boxes[index], boxes[index + 1]);
    }
  }
}

function record(input) {
  received.set(input.name, input.type === 'checkbox'
    ? String(input.checked)
    : (input.dataset.selectedValue || input.value));
  document.getElementById('received-state').textContent = JSON.stringify(Object.fromEntries(received), null, 2);
}

function bindInputs(root = document) {
  for (const input of root.querySelectorAll('input,textarea')) {
    if (input.dataset.bound) continue;
    input.dataset.bound = '1';
    input.addEventListener('input', () => record(input));
    input.addEventListener('change', () => record(input));
    const isPlainDraft = input.type !== 'checkbox' && !input.closest('[data-demo-select]') && !input.readOnly;
    if (isPlainDraft) {
      input.dataset.committedValue ||= '';
      input.addEventListener('blur', () => {
        // 模拟 Moka 单行 Input：只有真实失焦（activeElement 已改变）才提交草稿。
        if (document.activeElement !== input) input.dataset.committedValue = input.value;
      });
      input.addEventListener('focus', () => {
        for (const previous of document.querySelectorAll('input[data-committed-value],textarea[data-committed-value]')) {
          if (previous !== input && previous.value !== previous.dataset.committedValue) {
            previous.value = previous.dataset.committedValue || '';
          }
        }
      });
    }
  }
}

function bindSelect(box) {
  if (box.dataset.selectBound) return;
  box.dataset.selectBound = '1';
  const input = box.querySelector('input');
  if (!input) return;
  const display = document.createElement('span');
  display.className = 'sd-Input-display-value-x';
  display.dataset.selectDisplay = '1';
  input.parentElement.insertBefore(display, input);
  const options = JSON.parse(box.dataset.demoSelect || '[]');
  input.addEventListener('click', () => {
    box.querySelector('[class*="Dropdown-dropdown"]')?.remove();
    const menu = document.createElement('div');
    menu.className = 'sd-Dropdown-dropdown-x';
    for (const option of options) {
      const item = document.createElement('div');
      item.className = 'sd-Menu-content-item-x';
      const title = document.createElement('div');
      title.textContent = option;
      const subtitle = document.createElement('div');
      subtitle.className = 'sd-Menu-sub-title-x';
      const subtitleText = document.createElement('span');
      subtitleText.className = 'option-sub-title-x';
      subtitle.append(subtitleText);
      item.append(title, subtitle);
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        input.value = '';
        input.dataset.selectedValue = option;
        input.placeholder = '';
        display.textContent = option;
        // Moka 选择年份后会给空月份补一月；这不是用户输入。
        if (/year/.test(input.name)) {
          const pair = box.parentElement;
          const month = [...pair.querySelectorAll('input')].find((item) => /month/.test(item.name));
          if (month && !month.dataset.selectedValue) {
            month.dataset.selectedValue = '1';
            month.placeholder = '';
            month.parentElement.querySelector('[data-select-display]').textContent = '1';
            record(month);
          }
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        menu.remove();
      });
      menu.append(item);
    }
    const customKind = box.dataset.demoCustomEntry;
    if (customKind) {
      const prompt = document.createElement('div');
      prompt.className = 'custom-option-x';
      const firstButton = document.createElement('button');
      firstButton.type = 'button';
      firstButton.textContent = customKind === 'school' ? '添加学校全称' : '添加专业全称';
      firstButton.addEventListener('click', () => {
        menu.replaceChildren();
        const customInput = document.createElement('input');
        customInput.placeholder = customKind === 'school' ? '请输入就读学校全称' : '请输入专业全称';
        customInput.value = input.value;
        const commit = document.createElement('button');
        commit.type = 'button';
        commit.textContent = '添加';
        commit.addEventListener('click', () => {
          input.value = '';
          input.dataset.selectedValue = customInput.value;
          display.textContent = customInput.value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          menu.remove();
        });
        menu.append(customInput, commit);
      });
      prompt.append(firstButton);
      menu.append(prompt);
    }
    box.append(menu);
  });
}

function setupControls(root = document) {
  bindInputs(root);
  for (const box of root.querySelectorAll('[data-demo-select]')) bindSelect(box);
}

function setupAdds() {
  for (const block of document.querySelectorAll('[class*="apply-block-"]')) {
    const button = block.querySelector(':scope > [class*="blockTitle"] button');
    const first = block.querySelector(':scope > [data-record-section]');
    if (!button || !first) continue;
    button.addEventListener('click', () => {
      const records = block.querySelectorAll(':scope > [data-record-section]');
      const index = records.length + 1;
      const clone = first.cloneNode(true);
      for (const input of clone.querySelectorAll('input,textarea')) {
        input.checked = false;
        input.value = '';
        input.dataset.selectedValue = '';
        input.dataset.bound = '';
        input.name = input.name.replace(/-1$/, `-${index}`);
      }
      for (const box of clone.querySelectorAll('[data-demo-select]')) {
        box.dataset.selectBound = '';
        box.querySelector('[data-select-display]')?.remove();
        box.querySelector('[class*="Dropdown-dropdown"]')?.remove();
      }
      block.append(clone);
      setupControls(clone);
    });
  }
}

function renderMonths(box, input, year) {
  const panel = box.querySelector('[data-picker-panel]');
  panel.replaceChildren();
  const header = document.createElement('span');
  header.className = 'sd-basic-selector-year-x';
  header.textContent = `${year}年`;
  panel.append(header);
  const names = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
  names.forEach((name, index) => {
    const item = document.createElement('div');
    item.className = 'sd-basic-year-wrapper-x';
    const option = document.createElement('div');
    option.className = 'sd-basic-year-item-x';
    option.textContent = name;
    item.append(option);
    option.addEventListener('click', () => {
      input.value = `${year}-${String(index + 1).padStart(2, '0')} (age)`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      panel.remove();
    });
    panel.append(item);
  });
}

function renderYears(box, input, start = 1990) {
  const panel = box.querySelector('[data-picker-panel]');
  panel.replaceChildren();
  const left = document.createElement('span');
  left.className = 'sd-Icon-icondoubleLeft-x';
  left.addEventListener('click', () => renderYears(box, input, start - 10));
  const header = document.createElement('span');
  header.className = 'sd-basic-selector-year-x';
  header.textContent = `${start} - ${start + 9}`;
  const right = document.createElement('span');
  right.className = 'sd-Icon-icondoubleRight-x';
  right.addEventListener('click', () => renderYears(box, input, start + 10));
  panel.append(left, header, right);
  for (let year = start - 1; year <= start + 10; year += 1) {
    const item = document.createElement('div');
    item.className = 'sd-basic-year-wrapper-x';
    const option = document.createElement('div');
    option.className = 'sd-basic-year-item-x';
    option.textContent = String(year);
    item.append(option);
    if (year < start || year > start + 9) item.classList.add('sd-basic-disabled-x');
    else option.addEventListener('click', () => renderMonths(box, input, year));
    panel.append(item);
  }
}

function setupMonthPicker(box) {
  const input = box.querySelector('input');
  input.addEventListener('click', () => {
    box.querySelector('[data-picker-panel]')?.remove();
    const panel = document.createElement('div');
    panel.dataset.pickerPanel = '1';
    const header = document.createElement('span');
    header.className = 'sd-basic-selector-year-x';
    header.textContent = '2000年';
    header.addEventListener('click', () => renderYears(box, input));
    panel.append(header);
    box.append(panel);
    renderMonths(box, input, 1990);
    box.querySelector('[class*="sd-basic-selector-year"]').addEventListener('click', () => renderYears(box, input));
  });
}

setupDateRanges();
setupControls();
setupAdds();
for (const box of document.querySelectorAll('[data-demo-month-picker]')) setupMonthPicker(box);
window.__mokaReceived = () => Object.fromEntries(received);

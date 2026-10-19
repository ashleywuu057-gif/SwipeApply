const received = new Map();

function record(element) {
  const name = element.getAttribute('name') || element.dataset.name;
  if (!name) return;
  const value = element.type === 'checkbox'
    ? String(element.checked)
    : (element.dataset.selectedValues || element.dataset.selectedValue || element.value || '');
  received.set(name, value);
}

function closeLayers() {
  document.querySelectorAll('.common-unmodeled-layer').forEach((layer) => layer.remove());
}

function setSelectValue(box, input, value) {
  // 真实北森的学校搜索框在选中后会保留输入值，普通
  // Phoenix select 则把值放在独立的展示节点中。
  input.value = box.classList.contains('phoenix-auto-complete-container') ? value : '';
  input.dataset.selectedValue = value;
  box.querySelector('.phoenix-select__placeHolder')?.remove();
  let display = box.querySelector('.phoenix-select__tipEle');
  if (!display) {
    display = document.createElement('span');
    display.className = 'phoenix-select__tipEle';
    box.prepend(display);
  }
  display.textContent = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  record(input);
  if (input.name === 'education-degree-1' && value === '硕士研究生') {
    revealEducationDetails(box.closest('[data-record]'));
  }
  if (box.dataset.shiftOnSelect && !document.querySelector('[data-shift-decoy]')) {
    // 模拟真实 React 表单在选择后重新排列控件，使后续扫描的 fieldId
    // 全部偏移。执行器必须按语义和记录身份复查，不能按旧下标读回。
    const decoy = document.createElement('div');
    decoy.dataset.shiftDecoy = '1';
    decoy.className = 'form-item form-item--phoenix';
    decoy.innerHTML = '<div class="form-item__title"><label class="form-item__text">回归占位字段</label></div><div class="form-item__control"><input name="shift-decoy"></div>';
    document.querySelector('#beisen-form')?.prepend(decoy);
  }
  closeLayers();
}

function setMultiSelectValue(box, input, values) {
  input.value = '';
  delete input.dataset.selectedValue;
  input.dataset.selectedValues = JSON.stringify(values);
  box.querySelector('.phoenix-select__placeHolder')?.remove();
  box.querySelectorAll('.phoenix-select__tipEle').forEach((display) => display.remove());
  for (const value of values) {
    const display = document.createElement('span');
    display.className = 'phoenix-select__tipEle';
    display.textContent = value;
    box.prepend(display);
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  record(input);
  closeLayers();
}

function revealEducationDetails(recordRoot) {
  if (!recordRoot || recordRoot.querySelector('[data-dynamic-education-details]')) return;
  const details = document.createElement('div');
  details.setAttribute('data-dynamic-education-details', '1');
  details.style.display = 'contents';
  details.innerHTML = `
    <div class="form-item form-item--phoenix"><div class="form-item__title"><label class="form-item__text">学号</label></div><div class="form-item__control"><div class="phoenix-input"><input class="phoenix-input__input" name="education-student-number-1" placeholder="请输入"></div></div></div>
    <div class="form-item form-item--phoenix"><div class="form-item__title"><label class="form-item__text">实验室</label></div><div class="form-item__control"><div class="phoenix-input"><input class="phoenix-input__input" name="education-lab-1" placeholder="请输入"></div></div></div>
    <div class="form-item form-item--phoenix"><div class="form-item__title"><label class="form-item__text">研究方向</label></div><div class="form-item__control"><div class="phoenix-input"><input class="phoenix-input__input" name="education-research-1" placeholder="请输入"></div></div></div>
    <div class="form-item form-item--phoenix"><div class="form-item__title"><label class="form-item__text">导师</label></div><div class="form-item__control"><div class="phoenix-input"><input class="phoenix-input__input" name="education-advisor-1" placeholder="请输入"></div></div></div>`;
  recordRoot.append(details);
  bind(details);
}

function openSelect(box) {
  closeLayers();
  const input = box.querySelector('input');
  const layer = document.createElement('div');
  layer.className = 'common-unmodeled-layer common-unmodeled-layer-placement-bottomLeft';
  const list = document.createElement('div');
  list.className = 'phoenix-selectList';
  const options = JSON.parse(box.dataset.options || '[]');
  for (const value of options) {
    const item = document.createElement('div');
    item.className = 'phoenix-selectList__listItem';
    const label = document.createElement('div');
    label.className = 'phoenix-selectList__singleLabel';
    label.textContent = value;
    item.append(label);
    item.addEventListener('mousedown', (event) => event.preventDefault());
    item.addEventListener('click', () => setSelectValue(box, input, value));
    list.append(item);
  }
  layer.append(list);
  document.body.append(layer);
}

function openAreaPicker(box) {
  closeLayers();
  const input = box.querySelector('input');
  const options = JSON.parse(box.dataset.options || '[]');
  const multi = box.hasAttribute('data-area-multi');
  let selectedValue = null;
  let selectedValues = new Set();
  const layer = document.createElement('div');
  layer.className = 'common-unmodeled-layer common-unmodeled-layer-placement-bottomLeft';
  const picker = document.createElement('div');
  picker.className = 'area-selector-container';
  const searchWrap = document.createElement('div');
  searchWrap.className = 'area-search-input';
  const search = document.createElement('input');
  search.placeholder = '搜索';
  searchWrap.append(search);
  const content = document.createElement('div');
  content.className = 'content-container';
  const left = document.createElement('div');
  left.className = 'left-container';
  const data = document.createElement('div');
  data.className = 'area-data-container';
  left.append(data);
  const right = document.createElement('div');
  right.className = 'right-container';
  const header = document.createElement('div');
  header.innerHTML = `<span>已选地区</span><span class="select-data-num-text">0</span><span>/${multi ? 99 : 1}</span>`;
  const selected = document.createElement('div');
  selected.className = 'select-data-container';
  right.append(header, selected);
  content.append(left, right);
  const footer = document.createElement('div');
  footer.className = 'area-footer-button';
  const cancel = document.createElement('div');
  cancel.className = 'phoenix-button__content';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeLayers);
  const confirm = document.createElement('div');
  confirm.className = 'phoenix-button__content';
  confirm.textContent = '确定';
  confirm.addEventListener('click', () => {
    if (multi && selectedValues.size > 0) setMultiSelectValue(box, input, [...selectedValues]);
    else if (selectedValue) setSelectValue(box, input, selectedValue);
  });
  footer.append(cancel, confirm);

  const render = () => {
    data.replaceChildren();
    const keyword = search.value.trim();
    for (const value of options.filter((option) => !keyword || option.includes(keyword))) {
      const item = document.createElement('div');
      item.className = 'area-item-container';
      const name = document.createElement('div');
      name.className = 'area-item-name';
      const icon = document.createElement('span');
      icon.className = 'icon-container visible';
      // 真实 Phoenix 的单选图标是 SVGElement，不提供 HTMLElement.click()。
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const checked = multi ? selectedValues.has(value) : value === selectedValue;
      svg.setAttribute('class', multi
        ? checked ? 'area-icon-CheckboxChecked' : 'area-icon-CheckboxUnchecked'
        : checked ? 'area-icon-RadioChecked' : 'area-icon-RadioUnchecked');
      svg.setAttribute('width', '12');
      svg.setAttribute('height', '12');
      const label = document.createElement('span');
      label.className = 'area-text-label no-hover';
      label.textContent = value;
      icon.append(svg);
      icon.addEventListener('click', () => {
        if (multi) {
          if (selectedValues.has(value)) selectedValues.delete(value);
          else selectedValues.add(value);
        } else {
          selectedValue = value;
        }
        const values = multi ? [...selectedValues] : selectedValue ? [selectedValue] : [];
        header.querySelector('.select-data-num-text').textContent = String(values.length);
        selected.innerHTML = values
          .map((selectedArea) => `<div class="select-item-container"><span class="select-area-text-label">${selectedArea}</span></div>`)
          .join('');
        render();
      });
      name.append(icon, label);
      item.append(name);
      data.append(item);
    }
  };
  search.addEventListener('input', render);
  picker.append(searchWrap, content, footer);
  layer.append(picker);
  document.body.append(layer);
  render();
}

function openMonthPicker(box) {
  closeLayers();
  const input = box.querySelector('input');
  let year = 2026;
  const layer = document.createElement('div');
  layer.className = 'common-unmodeled-layer common-unmodeled-layer-placement-bottomLeft';
  const picker = document.createElement('div');
  picker.className = 'phoenix-date-picker';
  const content = document.createElement('div');
  content.className = 'phoenix-calendar-month-panel';
  const prev = document.createElement('a');
  prev.className = 'phoenix-calendar-month-panel-prev-year-btn';
  const yearSelect = document.createElement('a');
  yearSelect.className = 'phoenix-calendar-month-panel-year-select';
  const yearText = document.createElement('span');
  yearText.className = 'phoenix-calendar-month-panel-year-select-content';
  const next = document.createElement('a');
  next.className = 'phoenix-calendar-month-panel-next-year-btn';
  const renderYear = () => { yearText.textContent = String(year); };
  prev.addEventListener('click', () => { year -= 1; renderYear(); });
  next.addEventListener('click', () => { year += 1; renderYear(); });
  yearSelect.append(yearText);
  content.append(prev, yearSelect, next);
  for (let month = 1; month <= 12; month += 1) {
    const cell = document.createElement('div');
    cell.className = 'phoenix-calendar-month-panel-cell';
    const option = document.createElement('a');
    option.className = 'phoenix-calendar-month-panel-month';
    option.textContent = `${month}月`;
    option.addEventListener('click', () => setSelectValue(box, input, `${year}年${month}月`));
    cell.append(option);
    content.append(cell);
  }
  renderYear();
  picker.append(content);
  layer.append(picker);
  document.body.append(layer);
}

function openDayPicker(box) {
  closeLayers();
  const input = box.querySelector('input');
  let year = 2026;
  let month = 9;
  const layer = document.createElement('div');
  layer.className = 'common-unmodeled-layer common-unmodeled-layer-placement-bottomLeft';
  const picker = document.createElement('div');
  picker.className = 'phoenix-date-picker';
  const calendar = document.createElement('div');
  calendar.className = 'phoenix-calendar-date-panel';
  const header = document.createElement('div');
  header.className = 'phoenix-calendar-header';
  const body = document.createElement('div');
  body.className = 'phoenix-calendar-tbody';

  const renderDays = () => {
    header.replaceChildren();
    body.replaceChildren();
    const yearSelect = document.createElement('a');
    yearSelect.className = 'phoenix-calendar-year-select';
    yearSelect.textContent = `${year}年`;
    const monthSelect = document.createElement('a');
    monthSelect.className = 'phoenix-calendar-month-select';
    monthSelect.textContent = `${month}月`;
    yearSelect.addEventListener('click', renderYears);
    monthSelect.addEventListener('click', renderMonths);
    header.append(yearSelect, monthSelect);
    // 真实 Phoenix 日历会同时渲染相邻月份，日数因此重复。
    // 保留它的真实类名，回归防护必须只点当月的目标日期。
    const adjacentCell = document.createElement('div');
    adjacentCell.className = 'phoenix-calendar-cell phoenix-calendar-last-month-btn-day';
    const adjacentDay = document.createElement('div');
    adjacentDay.className = 'phoenix-calendar-date';
    adjacentDay.setAttribute('aria-disabled', 'false');
    adjacentDay.textContent = '15';
    adjacentCell.append(adjacentDay);
    body.append(adjacentCell);
    for (let day = 1; day <= 31; day += 1) {
      const cell = document.createElement('div');
      cell.className = 'phoenix-calendar-cell';
      const option = document.createElement('div');
      option.className = 'phoenix-calendar-date';
      option.setAttribute('aria-disabled', 'false');
      option.textContent = String(day);
      option.addEventListener('click', () => setSelectValue(box, input, `${year}年${month}月${day}日`));
      cell.append(option);
      body.append(cell);
    }
  };
  const renderYears = () => {
    body.replaceChildren();
    const panel = document.createElement('div');
    panel.className = 'phoenix-calendar-year-panel';
    const decadeStart = Math.floor(year / 10) * 10;
    const decade = document.createElement('span');
    decade.className = 'phoenix-calendar-year-panel-decade-select-content';
    decade.textContent = `${decadeStart}-${decadeStart + 9}`;
    const previous = document.createElement('a');
    previous.className = 'phoenix-calendar-year-panel-prev-decade-btn';
    previous.addEventListener('click', () => { year -= 10; renderYears(); });
    const next = document.createElement('a');
    next.className = 'phoenix-calendar-year-panel-next-decade-btn';
    next.addEventListener('click', () => { year += 10; renderYears(); });
    panel.append(previous, decade, next);
    for (let candidate = decadeStart - 1; candidate <= decadeStart + 10; candidate += 1) {
      const cell = document.createElement('div');
      cell.className = 'phoenix-calendar-year-panel-cell';
      const option = document.createElement('a');
      option.className = 'phoenix-calendar-year-panel-year';
      option.textContent = String(candidate);
      option.addEventListener('click', () => { year = candidate; renderDays(); });
      cell.append(option);
      panel.append(cell);
    }
    body.append(panel);
  };
  const renderMonths = () => {
    body.replaceChildren();
    const panel = document.createElement('div');
    panel.className = 'phoenix-calendar-month-panel';
    for (let candidate = 1; candidate <= 12; candidate += 1) {
      const cell = document.createElement('div');
      cell.className = 'phoenix-calendar-month-panel-cell';
      const option = document.createElement('a');
      option.className = 'phoenix-calendar-month-panel-month';
      option.textContent = `${candidate}月`;
      option.addEventListener('click', () => { month = candidate; renderDays(); });
      cell.append(option);
      panel.append(cell);
    }
    body.append(panel);
  };
  renderDays();
  calendar.append(header, body);
  picker.append(calendar);
  layer.append(picker);
  document.body.append(layer);
}

function bind(root = document) {
  for (const box of root.querySelectorAll('[data-options]:not([data-area-picker])')) {
    if (box.dataset.bound) continue;
    box.dataset.bound = '1';
    box.querySelector('input').addEventListener('click', () => openSelect(box));
  }
  for (const box of root.querySelectorAll('[data-area-picker]')) {
    if (box.dataset.bound) continue;
    box.dataset.bound = '1';
    box.querySelector('input').addEventListener('click', () => openAreaPicker(box));
  }
  for (const box of root.querySelectorAll('[data-month-picker]')) {
    if (box.dataset.bound) continue;
    box.dataset.bound = '1';
    box.querySelector('input').addEventListener('click', () => openMonthPicker(box));
  }
  for (const box of root.querySelectorAll('[data-day-picker]')) {
    if (box.dataset.bound) continue;
    box.dataset.bound = '1';
    box.querySelector('input').addEventListener('click', () => openDayPicker(box));
  }
  for (const group of root.querySelectorAll('.phoenix-radio-group')) {
    if (group.dataset.bound) continue;
    group.dataset.bound = '1';
    for (const item of group.querySelectorAll('.phoenix-radio-group__radioItem')) {
      // 真实 Phoenix 的点击处理在内层节点，不在 radioItem 外壳。
      item.querySelector('.phoenix-radio__radio-text').addEventListener('click', () => {
        group.querySelectorAll('.phoenix-radio').forEach((radio) => radio.classList.remove('phoenix-radio--checked'));
        item.querySelector('.phoenix-radio').classList.add('phoenix-radio--checked');
        received.set(group.dataset.name, item.textContent.trim());
      });
    }
  }
  for (const checkbox of root.querySelectorAll('.phoenix-checkbox')) {
    if (checkbox.dataset.bound) continue;
    checkbox.dataset.bound = '1';
    const input = checkbox.querySelector('input[type="checkbox"]');
    checkbox.querySelector('.phoenix-checkbox__box')?.addEventListener('click', (event) => {
      if (event.target === input) return;
      input.click();
    });
  }
  for (const input of root.querySelectorAll('input:not(.phoenix-select__input), textarea')) {
    if (input.dataset.plainBound) continue;
    input.dataset.plainBound = '1';
    input.addEventListener('input', () => record(input));
    input.addEventListener('change', () => record(input));
  }
}

for (const section of document.querySelectorAll('[data-repeated]')) {
  const add = section.querySelector('[id$="_addButton"]');
  add.addEventListener('click', () => {
    const records = section.querySelector('.beisen-records');
    const first = records.querySelector('[data-record]');
    const clone = first.cloneNode(true);
    const index = records.querySelectorAll(':scope > [data-record]').length + 1;
    for (const control of clone.querySelectorAll('input, textarea')) {
      control.value = '';
      control.checked = false;
      delete control.dataset.selectedValue;
      delete control.dataset.plainBound;
      control.name = control.name.replace(/-1$/, `-${index}`);
    }
    for (const widget of clone.querySelectorAll('[data-bound]')) delete widget.dataset.bound;
    for (const group of clone.querySelectorAll('[data-name]')) {
      group.dataset.name = group.dataset.name.replace(/-1$/, `-${index}`);
    }
    clone.querySelectorAll('.phoenix-select__tipEle').forEach((display) => display.remove());
    clone.querySelectorAll('.phoenix-radio--checked').forEach((radio) => radio.classList.remove('phoenix-radio--checked'));
    records.insertBefore(clone, add);
    bind(clone);
    // 真实北森在第一次新增后把每条记录提升到 body 的独立 wrapper，最后一个
    // wrapper 同时容纳添加入口。回归夹具复现这一结构，防止只扫描首条记录。
    const body = records.parentElement;
    const recordNodes = [...records.querySelectorAll(':scope > [data-record]')];
    if (body && recordNodes.length === 2) {
      const shells = recordNodes.map((recordNode) => {
        const shell = document.createElement('div');
        shell.className = 'beisen-record-shell';
        shell.append(recordNode);
        body.append(shell);
        return shell;
      });
      shells.at(-1).append(add);
      records.remove();
    }
  });
}

document.body.addEventListener('mousedown', (event) => {
  if (event.target === document.body) closeLayers();
});
bind();
window.__beisenReceived = () => Object.fromEntries(received);

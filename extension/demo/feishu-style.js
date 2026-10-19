const received = new Map();
const counts = { education: 1, career: 1, internship: 0, project: 1, award: 1, language: 1 };

function record(name, value) {
  received.set(name, String(value));
}

function field(label, control, required = false) {
  return `<div class="atsx-col atsx-col-24"><div class="atsx-row atsx-form-item">
    <div class="atsx-col atsx-form-item-label${required ? ' atsx-form-item-required' : ''}">${label}</div>
    <div class="atsx-col atsx-form-item-control-wrapper"><div class="atsx-form-item-control"><span class="atsx-form-item-children">${control}</span></div></div>
  </div></div>`;
}

function text(id, placeholder = '请输入', tag = 'input') {
  return tag === 'textarea'
    ? `<textarea id="${id}" name="${id}" placeholder="${placeholder}"></textarea>`
    : `<input id="${id}" name="${id}" class="atsx-input atsx-input-lg" placeholder="${placeholder}">`;
}

function select(id, options, searchable = false, multiple = false, area = false) {
  const popupId = `${id.replace(/[^a-z0-9]+/gi, '-')}-popup`;
  return `<div id="${id}" class="atsx-select atsx-select-lg${searchable ? ' atsx-select-combobox' : ''}" data-options='${JSON.stringify(options)}' data-area="${area}" data-multiple="${multiple}">
    <div class="atsx-select-selection atsx-select-selection--${multiple ? 'multiple' : 'single'}" role="combobox" aria-controls="${popupId}" aria-expanded="false" tabindex="0">
      <div class="atsx-select-selection__rendered"><div class="atsx-select-selection__placeholder">${searchable ? '请输入' : '请选择'}</div>
        <div class="atsx-select-search atsx-select-search--inline" style="display:${searchable || multiple ? 'block' : 'none'}"><input id="${id}" class="atsx-select-search__field" autocomplete="off"></div>
      </div>
    </div>
  </div>`;
}

function period(name) {
  return `<div class="atsx-date-picker atsx-date-picker-period-month" data-name="${name}">
    <div class="atsx-date-picker-period-month-label"><span data-cy="year">YYYY</span>-<span data-cy="month">MM</span></div>
    <div class="atsx-date-picker-period-line"></div>
    <div class="atsx-date-picker-period-month-label"><span data-cy="year">YYYY</span>-<span data-cy="month">MM</span></div>
    <input class="atsx-date-picker-period-hidden-input">
  </div>`;
}

function yearPicker(name) {
  return `<div class="atsx-date-picker" data-name="${name}"><input class="atsx-input atsx-input-lg" name="${name}" placeholder="YYYY"></div>`;
}

function recordHtml(type, index, last) {
  let contents = '';
  if (type === 'education') contents = [
    field('学校', select(`education[${index}].school`, ['示例理工大学', '示例工程学院'], true), true),
    field('学历', select(`education[${index}].degree`, ['本科', '硕士研究生', '博士研究生']), true),
    field('专业', text(`education[${index}].fieldOfStudy`), true),
    field('起止时间', period(`education[${index}].date`), true),
  ].join('');
  if (type === 'career') contents = [
    field('公司', text(`career[${index}].company`)), field('职位', text(`career[${index}].title`)),
    field('起止时间', period(`career[${index}].date`)), field('描述', text(`career[${index}].desc`, '请输入', 'textarea')),
  ].join('');
  if (type === 'internship') contents = [
    field('公司', text(`internship[${index}].company`)), field('职位', text(`internship[${index}].title`)),
    field('起止时间', period(`internship[${index}].date`)), field('描述', text(`internship[${index}].desc`, '请输入', 'textarea')),
  ].join('');
  if (type === 'project') contents = [
    field('项目名称', text(`project[${index}].name`), true), field('项目角色', text(`project[${index}].role`)),
    field('起止时间', period(`project[${index}].date`)), field('项目链接', text(`project[${index}].link`)),
    field('项目描述', text(`project[${index}].desc`, '请输入', 'textarea')),
  ].join('');
  if (type === 'award') contents = [
    field('奖项名称', text(`award[${index}].title`), true), field('获奖时间', yearPicker(`award[${index}].date`)),
    field('描述', text(`award[${index}].desc`, '请输入', 'textarea')),
  ].join('');
  if (type === 'language') contents = [
    field('语言', select(`language[${index}].language`, ['英语', '日语', '德语']), true),
    field('精通程度', select(`language[${index}].proficiency`, ['入门', '良好', '熟练', '精通']), true),
  ].join('');
  return `<div class="resumeEditForm-item resumeEditForm-${type}"><div class="atsx-row-flex atsx-row-flex-space-between atsx-row-flex-middle">${contents}</div>${last ? '<div class="formOperate-addBtn"><span class="addMore-add">添加</span></div>' : ''}</div>`;
}

function section(type, title, description, body, multiple = false) {
  return `<section class="${multiple ? 'createFormSection-mutiple ' : ''}createFormSection__fixture" data-section="${type}">
    <div class="createFormSection-left"><div class="createFormSection-title">${title}</div><div class="createFormSection-description">${description}</div></div>
    <div class="createFormSection-right">${body}</div>
  </section>`;
}

function repeatedBody(type) {
  if (counts[type] === 0) return '<div class="createFormSection-addBtn"><span class="addMore-add">添加</span></div>';
  return `<div class="createFormSection-formList createFormSection-formList-mutiple">${Array.from({ length: counts[type] }, (_, i) => recordHtml(type, i + 1, i + 1 === counts[type])).join('')}</div>`;
}

function render() {
  const form = document.querySelector('#feishu-form');
  form.innerHTML = [
    section('preferences', '申请信息', '', `<div class="atsx-row-flex">${field('意向城市', select('application_preferred_city_list', ['上海', '合肥'], false, true), true)}${field('接受调剂到其他城市', '<label class="atsx-checkbox-wrapper"><input id="accept_transfer_preferred_city" name="accept_transfer_preferred_city" type="checkbox">接受调剂到其他城市</label>')}</div>`),
    section('personal', '基础信息', '请填写基本信息', `<div class="atsx-row-flex">${field('姓名', text('name'), true)}${field('邮箱', text('email'), true)}${field('年龄', text('age'))}${field('性别', select('gender', ['男', '女', '保密']))}${field('所在地', select('current_city_code', ['杭州', '上海'], false, false, true))}${field('家乡', select('hometown_city_code', ['苏州市', '吴中区'], false, false, true))}</div>`),
    section('education', '教育经历', '请填写教育经历', repeatedBody('education'), true),
    section('career', '工作经历', '请填写工作经历', `<label class="atsx-checkbox-wrapper"><input id="no-career" name="no-career" type="checkbox">没有工作经历</label>${repeatedBody('career')}`, true),
    section('internship', '实习经历', '', repeatedBody('internship'), true),
    section('project', '项目经历', '', repeatedBody('project'), true),
    section('award', '获奖', '', repeatedBody('award'), true),
    section('language', '语言能力', '', repeatedBody('language'), true),
    section('selfIntroduction', '自我评价', '', '<div class="createFormSection-addBtn"><span class="addMore-add">添加</span></div>'),
  ].join('');
  // 模拟真实 ATS：首次写入邮箱后，稍晚的 React 状态同步会把它清空一次。
  form.querySelector('#email').dataset.lateRollback = 'pending';
  bind(form);
}

function closePopups() {
  document.querySelectorAll('.atsx-select-dropdown, .atsx-date-picker-dropdown').forEach((node) => node.remove());
  document.querySelectorAll('.atsx-select-selection').forEach((node) => node.setAttribute('aria-expanded', 'false'));
}

function setSelectValue(box, value) {
  const rendered = box.querySelector('.atsx-select-selection__rendered');
  rendered.querySelector('.atsx-select-selection__placeholder')?.remove();
  rendered.querySelectorAll('.atsx-select-selection-selected-value, .atsx-select-selection__choice').forEach((n) => n.remove());
  const display = document.createElement(box.dataset.multiple === 'true' ? 'span' : 'div');
  display.className = box.dataset.multiple === 'true' ? 'atsx-select-selection__choice' : 'atsx-select-selection-selected-value';
  if (box.dataset.multiple === 'true') {
    // 真实飞书 ATS 多选会把顺序号和字段文案放在同一个 choice 中。
    display.innerHTML = `<span class="select-item-tag">1</span><span class="select-item-label"></span>`;
    display.querySelector('.select-item-label').textContent = value;
  } else {
    display.textContent = value;
  }
  rendered.prepend(display);
  box.dataset.selectedValue = value;
  const input = box.querySelector('.atsx-select-search__field');
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  record(box.id, value);
  closePopups();
}

function openSelect(box) {
  closePopups();
  const role = box.querySelector('[role="combobox"]');
  role.setAttribute('aria-expanded', 'true');
  box.querySelector('.atsx-select-search').style.display = 'block';
  const popup = document.createElement('div');
  popup.id = role.getAttribute('aria-controls');
  popup.className = 'atsx-select-dropdown';
  if (box.dataset.area === 'true') {
    const tree = document.createElement('div');
    tree.className = 'atsx-tree';
    tree.setAttribute('role', 'tree');
    const renderTree = () => {
      tree.replaceChildren();
      const keyword = box.querySelector('.atsx-select-search__field').value.trim();
      for (const value of JSON.parse(box.dataset.options).filter((item) => !keyword || item.includes(keyword))) {
        const item = document.createElement('div');
        item.setAttribute('role', 'treeitem');
        const title = document.createElement('span');
        title.setAttribute('data-cy-value', value);
        title.textContent = value;
        title.addEventListener('click', () => setSelectValue(box, value));
        item.append(title);
        tree.append(item);
      }
    };
    box.querySelector('.atsx-select-search__field').addEventListener('input', renderTree, { once: false });
    renderTree();
    popup.append(tree);
  } else {
    const list = document.createElement('ul');
    list.setAttribute('role', 'listbox');
    for (const value of JSON.parse(box.dataset.options)) {
      const option = document.createElement('li');
      option.setAttribute('role', 'option');
      option.dataset.value = value;
      option.textContent = value;
      option.addEventListener('click', () => setSelectValue(box, value));
      list.append(option);
    }
    popup.append(list);
  }
  document.body.append(popup);
}

function openPeriod(root, edge) {
  closePopups();
  root.dataset.edge = String(edge);
  const popup = document.createElement('div');
  popup.className = 'atsx-date-picker-dropdown';
  const panel = document.createElement('div');
  panel.className = 'atsx-date-picker-period-month-panel';
  const yearList = document.createElement('div');
  yearList.className = 'atsx-date-picker-period-month-panel-list';
  const monthList = yearList.cloneNode(false);
  if (edge === 1) {
    const present = document.createElement('div');
    present.className = 'atsx-date-picker-period-month-panel-list-item';
    present.dataset.cy = '-';
    present.textContent = '至今';
    present.addEventListener('click', () => {
      const label = root.querySelectorAll('.atsx-date-picker-period-month-label')[1];
      label.textContent = '至今';
      record(`${root.dataset.name}.end`, '至今');
      root.querySelector('input').dispatchEvent(new Event('change', { bubbles: true }));
      closePopups();
    });
    yearList.append(present);
  }
  for (let year = 2030; year >= 1990; year -= 1) {
    const item = document.createElement('div');
    item.className = 'atsx-date-picker-period-month-panel-list-item';
    item.dataset.cy = String(year);
    item.textContent = String(year);
    item.addEventListener('click', () => { root.dataset.pendingYear = String(year); });
    yearList.append(item);
  }
  for (let month = 1; month <= 12; month += 1) {
    const value = String(month).padStart(2, '0');
    const item = document.createElement('div');
    item.className = 'atsx-date-picker-period-month-panel-list-item';
    item.dataset.cy = value;
    item.textContent = value;
    item.addEventListener('click', () => {
      if (!root.dataset.pendingYear) return;
      const label = root.querySelectorAll('.atsx-date-picker-period-month-label')[Number(root.dataset.edge)];
      label.querySelector('[data-cy="year"]').textContent = root.dataset.pendingYear;
      label.querySelector('[data-cy="month"]').textContent = value;
      record(`${root.dataset.name}.${Number(root.dataset.edge) === 0 ? 'start' : 'end'}`, `${root.dataset.pendingYear}-${value}`);
      root.querySelector('input').dispatchEvent(new Event('change', { bubbles: true }));
      closePopups();
    });
    monthList.append(item);
  }
  panel.append(yearList, monthList);
  popup.append(panel);
  document.body.append(popup);
}

function openYear(root) {
  closePopups();
  const popup = document.createElement('div');
  popup.className = 'atsx-date-picker-dropdown';
  const panel = document.createElement('div');
  panel.className = 'atsx-date-picker-panel';
  panel.innerHTML = '<div class="atsx-date-picker-panel-header"><i data-cy="prev">‹</i><span class="atsx-date-picker-panel-header-title">2018-2026</span><i data-cy="next">›</i></div><div class="atsx-date-picker-panel-body-year"><table><tbody><tr class="atsx-date-picker-panel-body-row"></tr></tbody></table></div>';
  const row = panel.querySelector('tr');
  for (let year = 2018; year <= 2026; year += 1) {
    const td = document.createElement('td');
    const item = document.createElement('div');
    item.className = 'atsx-date-picker-panel-body-cell-content';
    item.dataset.cy = String(year);
    item.textContent = String(year);
    item.addEventListener('click', () => {
      const input = root.querySelector('input');
      input.value = String(year);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      record(root.dataset.name, year);
      closePopups();
    });
    td.append(item); row.append(td);
  }
  popup.append(panel); document.body.append(popup);
}

function bind(root) {
  root.querySelectorAll('input:not(.atsx-select-search__field):not(.atsx-date-picker-period-hidden-input), textarea').forEach((input) => {
    input.addEventListener('input', (event) => {
      record(input.name || input.id, input.type === 'checkbox' ? input.checked : input.value);
      if (input.id === 'email') record('__emailInputType', event.inputType || 'plain-event');
      if (input.dataset.lateRollback === 'pending' && input.value) {
        input.dataset.lateRollback = 'done';
        setTimeout(() => {
          input.value = '';
          record(input.name || input.id, '');
        }, 120);
      }
    });
    input.addEventListener('change', () => record(input.name || input.id, input.type === 'checkbox' ? input.checked : input.value));
  });
  root.querySelectorAll('.atsx-select').forEach((box) => {
    box.querySelector('[role="combobox"]').addEventListener('click', () => openSelect(box));
    box.querySelector('.atsx-select-search__field').addEventListener('click', (event) => { event.stopPropagation(); openSelect(box); });
  });
  root.querySelectorAll('.atsx-date-picker-period-month').forEach((picker) => {
    picker.querySelectorAll('.atsx-date-picker-period-month-label').forEach((label, index) => label.addEventListener('click', () => openPeriod(picker, index)));
  });
  root.querySelectorAll('.atsx-date-picker:not(.atsx-date-picker-period-month)').forEach((picker) => picker.querySelector('input').addEventListener('click', () => openYear(picker)));
  root.querySelectorAll('.formOperate-addBtn, .createFormSection-addBtn').forEach((button) => button.addEventListener('click', () => {
    const sectionRoot = button.closest('[data-section]');
    const type = sectionRoot.dataset.section;
    if (type === 'selfIntroduction') {
      sectionRoot.querySelector('.createFormSection-right').innerHTML = `<div class="createFormSection-formList">${field('自我评价', text('selfEvaluation', '请输入', 'textarea'))}</div>`;
      bind(sectionRoot.querySelector('.createFormSection-right'));
      return;
    }
    counts[type] += 1;
    sectionRoot.querySelector('.createFormSection-right').innerHTML = repeatedBody(type);
    bind(sectionRoot.querySelector('.createFormSection-right'));
  }));
}

render();
window.__feishuReceived = () => Object.fromEntries(received);

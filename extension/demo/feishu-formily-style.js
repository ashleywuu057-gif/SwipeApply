/* 新版飞书招聘（ud-formily）结构回归页：只复现扩展依赖的 DOM 结构，内容均为虚构。 */
(() => {
  const form = document.getElementById('apply-form');

  const label = (text, required) =>
    `<div class="ud-formily-item-label"><div class="ud-formily-item-label-content"><span><label>${text}</label>${required ? '<span class="ud-formily-item-asterisk">*</span>' : ''}</span></div><span class="ud-formily-item-colon"></span></div>`;
  const control = (inner) =>
    `<div class="ud-formily-item-control"><div class="ud-formily-item-control-content"><div class="ud-formily-item-control-content-component">${inner}</div></div></div>`;
  const input = () =>
    '<div class="ud__input ud__input--size-lg"><label class="ud__input-input-wrap"><div class="ud__input-input__placeholder__wrapper"><input class="ud__native-input"></div></label></div>';
  // 学校：包在 .ud__select 里的搜索框，输入关键字后候选出现在页面最外层的下拉里
  const schoolSelect = () =>
    '<div class="ud__select"><div><div class="ud__input ud__input--size-lg"><label class="ud__input-input-wrap"><div class="ud__input-input__placeholder__wrapper"><input class="ud__native-input"></div></label></div></div></div>';
  // 学历：只读下拉，mousedown 展开；选中后显示在 selectItem 里
  const readonlySelect = () =>
    '<div class="ud__select"><div class="ud__select__selector ud__select__selector-readOnly"><div class="ud__select__selector__content"><div class="ud__select__selector__search"><input class="ud__select__selector__search__input ud__native-input" role="combobox" type="search" readonly></div></div></div></div>';
  const textarea = () => '<div class="ud__textarea"><textarea class="ud__native-textarea" rows="3"></textarea></div>';
  const item = (key, text, inner, required = true) =>
    `<div class="ud-formily-item ud-formily-item-label-align-left" id="formily-item-${key}">${label(text, required)}${control(inner)}</div>`;
  const addButton = (extra = '') =>
    `<button type="button" class="ud__button ud__button--text ud__button--text-primary ud__button--size-lg ${extra}"><span class="ud__button__icon-inline"></span>添加</button>`;
  const module = (title, right, empty = false) =>
    `<div class="applyFormModuleWrapper-windows ${empty ? 'applyFormModuleWrapper-empty ' : ''}applyFormModuleWrapper__f1x"><div class="applyFormModuleWrapper-left"><div class="applyFormModuleWrapper-title"><p class="applyFormModuleWrapper-text">${title}</p></div></div><div class="applyFormModuleWrapper-right">${right}</div></div>`;

  // 每类经历卡片里的字段（实习、项目、获奖、语言的 key 在真实页面上尚未核验，这里用最常见的命名）
  const CARD_FIELDS = {
    education: [['school', '学校名称', schoolSelect()], ['degree', '学历', readonlySelect()], ['field_of_study', '专业', input()]],
    internship: [['company', '公司名称', input()], ['title', '职位名称', input()], ['desc', '实习描述', textarea()]],
    project: [['name', '项目名称', input()], ['role', '项目角色', input()], ['desc', '项目描述', textarea()]],
    award: [['title', '奖项名称', input()], ['desc', '奖项描述', textarea(), false]],
    language: [['language', '语言', input()]],
  };
  const card = (kind) =>
    `<div class="apply-form-array-card__f1x"><div class="apply-form-array-card-content__f1x"><div class="register-form-group-wrapper">${CARD_FIELDS[kind].map(([k, t, c, r]) => item(k, t, c, r !== false)).join('')}</div></div><div class="apply-form-array-card-operate__f1x"><span></span>${addButton()}</div></div>`;
  const list = (kind, cards) =>
    `<div class="ud-formily-item ud-formily-item-label-align-right" id="formily-item-${kind}_list">${control(cards ? `<div class="cards">${card(kind)}</div>` : addButton('apply-form-array-card-add-float-right__f1x'))}</div>`;

  form.innerHTML = [
    module('申请信息', item('code_type', '推荐方式', '<span>无</span>')),
    module('基本信息', `<div class="register-form-group-wrapper">${[
      item('name', '姓名', input()),
      item('mobile', '手机号码', '<div class="wrapper__f1x">+86 000-0000-0000</div>'),
      item('email', '邮箱', input()),
      // 履历里没有的字段：用来验证「记住我补填的内容」
      item('marital', '婚姻状况', readonlySelect()),
    ].join('')}</div>`),
    module('教育经历', list('education', true)),
    module('实习经历', list('internship', false), true),
    module('项目经历', list('project', false), true),
    module('获奖', list('award', false), true),
    module('语言能力', list('language', false), true),
  ].join('');

  // ---------- ud 下拉：选项 portal 到 body ----------
  const SCHOOLS = ['示例理工大学', '示例理工大学（分校）', '示例工程学院', '示例师范大学'];
  const DEGREES = ['大专', '本科', '硕士研究生', '博士研究生'];
  const closeDropdown = () => document.querySelectorAll('.ud__select__dropdown').forEach((d) => d.parentElement.remove());
  const openDropdown = (anchor, options, onPick) => {
    closeDropdown();
    const r = anchor.getBoundingClientRect();
    const host = document.createElement('div');
    host.innerHTML = `<div class="ud__select__dropdown" style="position:absolute;left:${r.left}px;top:${r.bottom + window.scrollY}px;background:#fff;border:1px solid #ddd;z-index:10"><div class="ud__select__list">${options
      .map((o) => `<div class="ud__select__list__item" style="padding:4px 8px;cursor:pointer"><div class="ud__select__list__item__content"><span>${o}</span></div><div class="ud__select__list__item__check"></div></div>`)
      .join('')}</div></div>`;
    document.body.appendChild(host);
    host.querySelectorAll('.ud__select__list__item').forEach((item, i) =>
      item.addEventListener('click', () => { onPick(options[i]); closeDropdown(); }));
  };
  form.addEventListener('mousedown', (event) => {
    const selector = event.target.closest('.ud__select__selector-readOnly');
    if (!selector) return;
    const options = selector.closest('#formily-item-marital') ? ['未婚', '已婚'] : DEGREES;
    openDropdown(selector, options, (v) => {
      let item = selector.querySelector('.ud__select__selector__selectItem');
      if (!item) {
        item = document.createElement('div');
        item.className = 'ud__select__selector__selectItem';
        selector.querySelector('.ud__select__selector__content').prepend(item);
      }
      item.textContent = v;
    });
  });
  form.addEventListener('input', (event) => {
    const input = event.target;
    if (!input.closest('#formily-item-school')) return;
    const q = input.value.trim();
    if (!q) return closeDropdown();
    setTimeout(() => openDropdown(input, SCHOOLS.filter((s) => s.includes(q.slice(0, 2))), (v) => { input.value = v; }), 120);
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDropdown(); });

  // 「添加」：空分区换成第一张卡片；已有卡片时在末尾追加一张（和真实页面一样由页面自己渲染）
  form.addEventListener('click', (event) => {
    const button = event.target.closest('button.ud__button');
    if (!button) return;
    const listItem = button.closest('[id$="_list"]');
    const kind = listItem.id.replace('formily-item-', '').replace('_list', '');
    let cards = listItem.querySelector('.cards');
    setTimeout(() => {
      if (!cards) {
        listItem.querySelector('.ud-formily-item-control-content-component').innerHTML = '<div class="cards"></div>';
        cards = listItem.querySelector('.cards');
      }
      cards.insertAdjacentHTML('beforeend', card(kind));
    }, 50);
  });
})();

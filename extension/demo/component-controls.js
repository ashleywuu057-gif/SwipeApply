/* 独立的行为仿真：HTML 类名取自 Ant Mobile 2.x 的公开组件契约，全部内容为虚构。 */
const params = new URLSearchParams(location.search);
const received = {};
const opened = {};
let adds = 0;
const optionsById = {
  gender: [params.has('ambiguous') ? ['女', '男', '男'] : ['女', '男']],
  city: [['上海市', '杭州市', '北京市']],
  birth: [Array.from({ length: 151 }, (_, i) => `${1900 + i}年`), Array.from({ length: 12 }, (_, i) => `${i + 1}月`), Array.from({ length: 31 }, (_, i) => `${i + 1}日`)],
  native: [['江苏省', '浙江省'], ['苏州市', '杭州市']],
  nation: [['汉族', '回族']],
  degree: [['本科', '硕士', '博士']],
  eduStart: [Array.from({ length: 151 }, (_, i) => `${1900 + i}年`), ['9月'], ['1日']],
};
function row(id, label, value = '请选择', disabled = false) {
  return `<div${disabled ? ' aria-disabled="true"' : ''} class="am-list-item" id="${id}"><div class="am-list-line"><div class="am-list-content"><div>${label}</div></div><div class="am-list-extra">${value}</div><div class="am-list-arrow am-list-arrow-horizontal"></div></div></div>`;
}
function text(id, label) {
  return `<div class="text-row"><div class="field-label">${label}</div><div><input name="${id}"></div></div>`;
}
const personal = text('fullName', '姓名') + row('gender', '性别', params.has('existing') ? '女' : '请选择', params.has('disabled')) +
  row('city', '所在城市') + row('birth', '出生日期') + row('native', '籍贯') + row('nation', '民族') +
  '<div class="custom-row"><div class="field-label">起止时间</div><div><span>开始时间</span> ~ <span>结束时间</span></div></div>';
const form = document.querySelector('#fixture-form');
if (params.get('layout') === 'fieldset') {
  form.innerHTML = `<fieldset><legend>个人信息</legend>${personal}</fieldset>`;
} else {
  // 标题与内容为兄弟；包装类名没有任何“title”提示，不能依赖某公司生成的类名。
  form.innerHTML = `<div class="heading-shell"><span>基础信息</span></div><div>${personal}</div>
    <div class="heading-shell"><span>教育经历</span></div><div id="education"><button type="button" id="add-education">+ 添加</button></div>
    <div class="heading-shell"><span>实习经历</span></div><div id="internship">${text('company', '公司名称')}${text('title', '职位名称')}</div>
    <div class="heading-shell"><span>校园经历</span></div><div id="campus">${text('campus-company', '公司名称')}${text('campus-role', '担任职务')}</div>`;
}
form.addEventListener('input', (event) => {
  if (event.target instanceof HTMLInputElement) received[event.target.name] = event.target.value;
});
document.addEventListener('click', (event) => {
  if (event.target.closest('#add-education')) {
    adds += 1;
    document.querySelector('#add-education').insertAdjacentHTML('beforebegin',
      `<div class="education-record">${text('school', '学校名称')}${text('major', '专业名称')}${row('degree', '学历层次')}${row('eduStart', '入学日期')}</div>`);
    return;
  }
  const trigger = event.target.closest('.am-list-item');
  if (!trigger || trigger.getAttribute('aria-disabled') === 'true') return;
  opened[trigger.id] = (opened[trigger.id] ?? 0) + 1;
  const data = optionsById[trigger.id];
  if (!data) return;
  const popup = document.createElement('div');
  popup.className = 'am-picker-popup';
  popup.innerHTML = '<div class="am-picker-popup-header"><div class="am-picker-popup-item" role="button">取消</div><div class="am-picker-popup-item" role="button">确定</div></div><div class="am-picker"></div>';
  const selected = data.map(() => 0);
  data.forEach((items, colIndex) => {
    const col = document.createElement('div');
    col.className = 'am-picker-col';
    col.innerHTML = '<div class="am-picker-col-mask"></div><div class="am-picker-col-indicator"></div><div class="am-picker-col-content"></div>';
    const content = col.querySelector('.am-picker-col-content');
    content.innerHTML = items.map((item, index) => `<div class="am-picker-col-item${index === 0 ? ' am-picker-col-item-selected' : ''}">${item}</div>`).join('');
    let startY = 0;
    let startIndex = 0;
    let dragging = false;
    let position = 0;
    col.addEventListener('mousedown', (e) => {
      dragging = true; startY = e.pageY; startIndex = selected[colIndex];
      if (params.has('edit-during-pick') && trigger.id === 'gender') {
        trigger.querySelector('.am-list-extra').textContent = '用户新选择';
      }
    });
    col.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      position = startIndex + (startY - e.pageY) / 34;
      content.style.transform = `translateY(${-position * 34}px)`;
    });
    col.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const snapped = Math.max(0, Math.min(items.length - 1, Math.round(position)));
      // 与旧版 rc-picker 一致：不发生吸附位移时不会回调 scrollingComplete。
      if (snapped === position) return;
      // 模拟滚轮动画结束后才通知 onChange；选项自身故意没有 click 处理器。
      setTimeout(() => {
        selected[colIndex] = snapped;
        content.style.transform = `translateY(${-selected[colIndex] * 34}px)`;
        [...content.children].forEach((child, index) => child.classList.toggle('am-picker-col-item-selected', index === selected[colIndex]));
      }, 300);
    });
    popup.querySelector('.am-picker').append(col);
  });
  popup.querySelectorAll('.am-picker-popup-item')[0].addEventListener('click', () => popup.remove());
  popup.querySelectorAll('.am-picker-popup-item')[1].addEventListener('click', () => {
    const values = data.map((items, index) => items[selected[index]]);
    const value = trigger.id === 'birth' || trigger.id === 'eduStart'
      ? values.map((item) => String(parseInt(item, 10)).padStart(2, '0')).join('-') : values.join('');
    popup.remove();
    if (params.has('reject')) return;
    // React 式节点替换：验证扩展能在重扫后回读，不以旧节点作为成功证据。
    const replacement = trigger.cloneNode(true);
    replacement.querySelector('.am-list-extra').textContent = value;
    trigger.replaceWith(replacement);
    received[replacement.id] = value;
  });
  document.body.append(popup);
});
window.__componentFixture = () => ({ received, opened, adds });

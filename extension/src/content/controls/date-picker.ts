import { normalizeLabel } from '../../shared/normalize';
import { delay, isVisible, nextFrames, waitFor } from '../dom-utils';
import type { ControlEntry } from '../scanner';
import { failResult, okResult, readCurrentValue, type ControlResult } from '../verify';

/** 已验证的 ATS 年月选择器：逐步点选后回读，不直接改视觉 input。 */

const OPEN_TIMEOUT_MS = 2_000;
const STEP_TIMEOUT_MS = 1_000;
const MONTHS = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月',
];

function pickerRoot(input: HTMLInputElement): Element | null {
  return input.closest('[class*="Dropdown-container"]');
}

function visibleOne(root: Element, selector: string): HTMLElement | null {
  const matches = [...root.querySelectorAll<HTMLElement>(selector)].filter(isVisible);
  return matches.length === 1 ? matches[0]! : null;
}

function visibleWrappers(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[class*="sd-basic-year-wrapper"]')]
    .filter(isVisible)
    .filter((item) => !String(item.className || '').includes('disabled'));
}

function exactText(items: HTMLElement[], wanted: string): HTMLElement[] {
  const target = normalizeLabel(wanted).toLowerCase();
  return items.filter((item) => normalizeLabel(item.textContent ?? '').toLowerCase() === target);
}

/** Moka 把点击处理挂在内部 item；点击 wrapper 不会向子节点传播。 */
function optionTarget(wrapper: HTMLElement): HTMLElement | null {
  const items = [...wrapper.querySelectorAll<HTMLElement>('[class*="sd-basic-year-item"]')]
    .filter(isVisible);
  if (items.length === 0) return wrapper;
  return items.length === 1 ? items[0]! : null;
}

async function closePicker(input: HTMLInputElement): Promise<void> {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  input.ownerDocument.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await nextFrames(1);
}

function hasMonthValue(current: string, value: string): boolean {
  const wanted = /^(\d{4})-(\d{2})$/.exec(value);
  if (!wanted) return false;
  const actual = /(\d{4})\D{0,3}(\d{1,2})/.exec(current);
  return Boolean(actual && actual[1] === wanted[1] && Number(actual[2]) === Number(wanted[2]));
}

function hasDayValue(current: string, value: string): boolean {
  const wanted = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!wanted) return false;
  const actual = /(\d{4})\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})/.exec(current);
  return Boolean(actual && actual[1] === wanted[1] &&
    Number(actual[2]) === Number(wanted[2]) && Number(actual[3]) === Number(wanted[3]));
}

async function fillMokaDatePicker(
  entry: ControlEntry,
  value: string,
  overwrite: boolean,
): Promise<ControlResult> {
  const input = entry.primary as HTMLInputElement;
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return failResult('PRECISION_MISMATCH', '日期选择器需要 YYYY-MM');
  const targetYear = Number(match[1]);
  const targetMonth = Number(match[2]);
  if (targetMonth < 1 || targetMonth > 12) return failResult('PRECISION_MISMATCH', '月份不合法');

  const current = readCurrentValue(entry).trim();
  if (hasMonthValue(current, value)) return okResult('VALUE_ALREADY_EQUAL', '网页上已经是这个年月');
  if (current.length > 0 && !overwrite) return failResult('EXISTING_VALUE', '网页已有出生年月，已保留原值');

  const root = pickerRoot(input);
  if (!root) return failResult('UNSUPPORTED_WIDGET', '找不到日期选择器自己的弹层容器');

  input.focus({ preventScroll: true });
  input.click();
  const opened = await waitFor(
    () => visibleOne(root, '[class*="sd-basic-selector-year"]') !== null,
    OPEN_TIMEOUT_MS,
  );
  if (!opened) return failResult('TIMEOUT', '日期选择器没有在 2 秒内打开');

  let header = visibleOne(root, '[class*="sd-basic-selector-year"]');
  if (!header) return failResult('UNSUPPORTED_WIDGET', '日期选择器缺少年份标题');
  if (/^\d{4}年$/.test(normalizeLabel(header.textContent ?? ''))) {
    header.click();
    await waitFor(() => /\d{4}\s*-\s*\d{4}/.test(normalizeLabel(
      visibleOne(root, '[class*="sd-basic-selector-year"]')?.textContent ?? '',
    )), STEP_TIMEOUT_MS);
  }

  for (let guard = 0; guard < 30; guard += 1) {
    header = visibleOne(root, '[class*="sd-basic-selector-year"]');
    const decade = /(\d{4})\s*-\s*(\d{4})/.exec(normalizeLabel(header?.textContent ?? ''));
    if (!decade) {
      await closePicker(input);
      return failResult('UNSUPPORTED_WIDGET', '日期选择器的年份面板结构已变化');
    }
    const start = Number(decade[1]);
    const end = Number(decade[2]);
    if (targetYear >= start && targetYear <= end) break;
    const direction = targetYear < start ? 'doubleLeft' : 'doubleRight';
    const arrow = visibleOne(root, `[class*="icon${direction}"]`);
    if (!arrow) {
      await closePicker(input);
      return failResult('UNSUPPORTED_WIDGET', '找不到可用的年份翻页按钮');
    }
    arrow.click();
    await delay(40);
  }

  const yearMatches = exactText(visibleWrappers(root), String(targetYear));
  if (yearMatches.length !== 1) {
    await closePicker(input);
    return failResult('AMBIGUOUS_OPTION', `无法唯一定位年份 ${targetYear}`);
  }
  const yearTarget = optionTarget(yearMatches[0]!);
  if (!yearTarget) {
    await closePicker(input);
    return failResult('AMBIGUOUS_OPTION', '年份选项包含多个点击目标');
  }
  yearTarget.click();
  const monthReady = await waitFor(
    () => exactText(visibleWrappers(root), MONTHS[targetMonth - 1]!).length === 1,
    STEP_TIMEOUT_MS,
  );
  if (!monthReady) {
    await closePicker(input);
    return failResult('TIMEOUT', '月份选择面板没有出现');
  }

  const monthTarget = optionTarget(exactText(visibleWrappers(root), MONTHS[targetMonth - 1]!)[0]!);
  if (!monthTarget) {
    await closePicker(input);
    return failResult('AMBIGUOUS_OPTION', '月份选项包含多个点击目标');
  }
  monthTarget.click();
  await nextFrames(2);
  await delay(60);
  if (!input.isConnected) return failResult('STALE_PAGE', '选择日期后网页替换了节点');
  if (!hasMonthValue(readCurrentValue(entry).trim(), value)) {
    await closePicker(input);
    return failResult('VALIDATION_FAILED', '点选年月后网页没有回显目标值');
  }
  return okResult('FILLED_VERIFIED', '');
}

function phoenixPicker(document: Document): HTMLElement | null {
  const popups = [...document.querySelectorAll<HTMLElement>('.common-unmodeled-layer')]
    .filter(isVisible)
    .filter((layer) => layer.querySelector('.phoenix-date-picker'));
  return popups.length === 1 ? popups[0]! : null;
}

async function selectPhoenixYear(
  input: HTMLInputElement,
  root: HTMLElement,
  targetYear: number,
  precision: 'month' | 'day',
): Promise<ControlResult | null> {
  const yearButtonSelector = precision === 'day'
    ? '.phoenix-calendar-year-select'
    : '.phoenix-calendar-month-panel-year-select';
  const yearTextSelector = precision === 'day'
    ? '.phoenix-calendar-year-select'
    : '.phoenix-calendar-month-panel-year-select-content';
  const yearText = () => visibleOne(root, yearTextSelector);
  const shownYear = Number.parseInt(normalizeLabel(yearText()?.textContent ?? ''), 10);
  if (!Number.isInteger(shownYear)) {
    await closePicker(input);
    return failResult('UNSUPPORTED_WIDGET', 'Phoenix 日期选择器缺少当前年份');
  }
  if (shownYear === targetYear) return null;

  const yearButton = visibleOne(root, yearButtonSelector);
  yearButton?.click();
  const panelOpened = await waitFor(
    () => visibleOne(root, '.phoenix-calendar-year-panel-decade-select-content') !== null,
    350,
  );
  if (panelOpened) {
    for (let guard = 0; guard < 30; guard += 1) {
      const decadeNode = visibleOne(root, '.phoenix-calendar-year-panel-decade-select-content');
      const decade = /(\d{4})\s*-\s*(\d{4})/.exec(normalizeLabel(decadeNode?.textContent ?? ''));
      if (!decade) {
        await closePicker(input);
        return failResult('UNSUPPORTED_WIDGET', 'Phoenix 年份面板结构已变化');
      }
      const start = Number(decade[1]);
      const end = Number(decade[2]);
      if (targetYear >= start && targetYear <= end) break;
      const arrow = visibleOne(root, targetYear < start
        ? '.phoenix-calendar-year-panel-prev-decade-btn'
        : '.phoenix-calendar-year-panel-next-decade-btn');
      if (!arrow) {
        await closePicker(input);
        return failResult('UNSUPPORTED_WIDGET', '找不到 Phoenix 年代翻页按钮');
      }
      const before = normalizeLabel(decadeNode?.textContent ?? '');
      arrow.click();
      const moved = await waitFor(
        () => normalizeLabel(visibleOne(root, '.phoenix-calendar-year-panel-decade-select-content')?.textContent ?? '') !== before,
        STEP_TIMEOUT_MS,
      );
      if (!moved) {
        await closePicker(input);
        return failResult('TIMEOUT', 'Phoenix 年代没有按预期翻页');
      }
    }

    const years = exactText(
      [...root.querySelectorAll<HTMLElement>('.phoenix-calendar-year-panel-year')]
        .filter(isVisible)
        .filter((option) => !String(option.parentElement?.className || '').includes('disabled')),
      String(targetYear),
    );
    if (years.length !== 1) {
      await closePicker(input);
      return failResult('AMBIGUOUS_OPTION', `无法唯一定位年份 ${targetYear}`);
    }
    years[0]!.click();
    const selected = await waitFor(
      () => Number.parseInt(normalizeLabel(yearText()?.textContent ?? ''), 10) === targetYear,
      STEP_TIMEOUT_MS,
    );
    if (!selected) {
      await closePicker(input);
      return failResult('TIMEOUT', 'Phoenix 年份选择没有生效');
    }
    return null;
  }

  // 旧版 Phoenix 月选择器没有年代面板，保留逐年翻页作为兼容路径。
  const difference = targetYear - shownYear;
  if (Math.abs(difference) > 100) {
    await closePicker(input);
    return failResult('PRECISION_MISMATCH', '目标年份超出可安全翻页范围');
  }
  const arrowSelector = difference < 0
    ? precision === 'day' ? '.phoenix-calendar-prev-year-btn' : '.phoenix-calendar-month-panel-prev-year-btn'
    : precision === 'day' ? '.phoenix-calendar-next-year-btn' : '.phoenix-calendar-month-panel-next-year-btn';
  for (let step = 0; step < Math.abs(difference); step += 1) {
    const before = Number.parseInt(normalizeLabel(yearText()?.textContent ?? ''), 10);
    const arrow = visibleOne(root, arrowSelector);
    if (!arrow) {
      await closePicker(input);
      return failResult('UNSUPPORTED_WIDGET', '找不到 Phoenix 年份翻页按钮');
    }
    arrow.click();
    const moved = await waitFor(
      () => Number.parseInt(normalizeLabel(yearText()?.textContent ?? ''), 10) !== before,
      STEP_TIMEOUT_MS,
    );
    if (!moved) {
      await closePicker(input);
      return failResult('TIMEOUT', 'Phoenix 年份没有按预期翻页');
    }
  }
  return null;
}

async function fillBeisenDatePicker(
  entry: ControlEntry,
  value: string,
  overwrite: boolean,
): Promise<ControlResult> {
  const input = entry.primary as HTMLInputElement;
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return failResult('PRECISION_MISMATCH', '日期选择器需要 YYYY-MM');
  const targetYear = Number(match[1]);
  const targetMonth = Number(match[2]);
  if (targetMonth < 1 || targetMonth > 12) return failResult('PRECISION_MISMATCH', '月份不合法');

  const current = readCurrentValue(entry).trim();
  if (hasMonthValue(current, value)) return okResult('VALUE_ALREADY_EQUAL', '网页上已经是这个年月');
  if (current && !overwrite) return failResult('EXISTING_VALUE', '网页已有年月，已保留原值');

  input.focus({ preventScroll: true });
  input.click();
  const opened = await waitFor(() => phoenixPicker(input.ownerDocument) !== null, OPEN_TIMEOUT_MS);
  const root = phoenixPicker(input.ownerDocument);
  if (!opened || !root) return failResult('TIMEOUT', 'Phoenix 日期选择器没有在 2 秒内打开');

  const yearError = await selectPhoenixYear(input, root, targetYear, 'month');
  if (yearError) return yearError;

  const monthOptions = [...root.querySelectorAll<HTMLElement>('.phoenix-calendar-month-panel-month')]
    .filter(isVisible)
    .filter((option) => !String(option.parentElement?.className || '').includes('disabled'));
  const matches = exactText(monthOptions, `${targetMonth}月`);
  if (matches.length !== 1) {
    await closePicker(input);
    return failResult('AMBIGUOUS_OPTION', `无法唯一定位 ${targetMonth} 月`);
  }
  matches[0]!.click();
  await nextFrames(2);
  await delay(60);
  if (!input.isConnected) return failResult('STALE_PAGE', '选择日期后网页替换了节点');
  if (!hasMonthValue(readCurrentValue(entry), value)) {
    await closePicker(input);
    return failResult('VALIDATION_FAILED', '点选年月后网页没有回显目标值');
  }
  return okResult('FILLED_VERIFIED', '');
}

async function fillBeisenDayPicker(
  entry: ControlEntry,
  value: string,
  overwrite: boolean,
): Promise<ControlResult> {
  const input = entry.primary as HTMLInputElement;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return failResult('PRECISION_MISMATCH', '日期选择器需要 YYYY-MM-DD');
  const targetYear = Number(match[1]);
  const targetMonth = Number(match[2]);
  const targetDay = Number(match[3]);
  if (targetMonth < 1 || targetMonth > 12 || targetDay < 1 || targetDay > 31) {
    return failResult('PRECISION_MISMATCH', '日期不合法');
  }

  const current = readCurrentValue(entry).trim();
  if (hasDayValue(current, value)) return okResult('VALUE_ALREADY_EQUAL', '网页上已经是这个日期');
  if (current && !overwrite) return failResult('EXISTING_VALUE', '网页已有日期，已保留原值');

  input.focus({ preventScroll: true });
  input.click();
  const opened = await waitFor(() => phoenixPicker(input.ownerDocument) !== null, OPEN_TIMEOUT_MS);
  const root = phoenixPicker(input.ownerDocument);
  if (!opened || !root) return failResult('TIMEOUT', 'Phoenix 日期选择器没有在 2 秒内打开');
  if (!visibleOne(root, '.phoenix-calendar-date-panel')) {
    await closePicker(input);
    return failResult('UNSUPPORTED_WIDGET', '网页日期选择器不是完整日期模式');
  }

  const yearError = await selectPhoenixYear(input, root, targetYear, 'day');
  if (yearError) return yearError;

  const monthButton = visibleOne(root, '.phoenix-calendar-month-select');
  if (!monthButton) {
    await closePicker(input);
    return failResult('UNSUPPORTED_WIDGET', 'Phoenix 日期选择器缺少月份入口');
  }
  monthButton.click();
  const monthReady = await waitFor(
    () => exactText(
      [...root.querySelectorAll<HTMLElement>('.phoenix-calendar-month-panel-month')].filter(isVisible),
      `${targetMonth}月`,
    ).length === 1,
    STEP_TIMEOUT_MS,
  );
  if (!monthReady) {
    await closePicker(input);
    return failResult('TIMEOUT', 'Phoenix 月份面板没有出现');
  }
  const monthMatches = exactText(
    [...root.querySelectorAll<HTMLElement>('.phoenix-calendar-month-panel-month')]
      .filter(isVisible)
      .filter((option) => !String(option.parentElement?.className || '').includes('disabled')),
    `${targetMonth}月`,
  );
  if (monthMatches.length !== 1) {
    await closePicker(input);
    return failResult('AMBIGUOUS_OPTION', `无法唯一定位 ${targetMonth} 月`);
  }
  monthMatches[0]!.click();
  const dayReady = await waitFor(
    () => visibleOne(root, '.phoenix-calendar-date-panel') !== null,
    STEP_TIMEOUT_MS,
  );
  if (!dayReady) {
    await closePicker(input);
    return failResult('TIMEOUT', 'Phoenix 日期面板没有恢复');
  }

  const days = exactText(
    [...root.querySelectorAll<HTMLElement>('.phoenix-calendar-tbody .phoenix-calendar-date')]
      .filter(isVisible)
      .filter((day) => day.getAttribute('aria-disabled') !== 'true')
      .filter((day) => {
        const cellClass = String(day.closest('.phoenix-calendar-cell')?.className || '');
        // Phoenix 不同版本对相邻月份日期使用过两套类名。
        // 它们会与当月出现相同的日数，必须排除后才能唯一点选。
        return !/(?:last|next)-month-(?:cell|btn-day)/.test(cellClass);
      }),
    String(targetDay),
  );
  if (days.length !== 1) {
    await closePicker(input);
    return failResult('AMBIGUOUS_OPTION', `无法唯一定位 ${targetDay} 日`);
  }
  days[0]!.click();
  await nextFrames(2);
  await delay(60);
  if (!input.isConnected) return failResult('STALE_PAGE', '选择日期后网页替换了节点');
  if (!hasDayValue(readCurrentValue(entry), value)) {
    await closePicker(input);
    return failResult('VALIDATION_FAILED', '点选日期后网页没有回显目标值');
  }
  return okResult('FILLED_VERIFIED', '');
}

function visibleFeishuDropdown(document: Document, childSelector: string): HTMLElement | null {
  const matches = [...document.querySelectorAll<HTMLElement>('.atsx-date-picker-dropdown')]
    .filter(isVisible)
    .filter((dropdown) => dropdown.querySelector(childSelector));
  return matches.length === 1 ? matches[0]! : null;
}

function exactDataValue(root: Element, selector: string, value: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)]
    .filter(isVisible)
    .filter((item) => (item.getAttribute('data-cy') ?? normalizeLabel(item.textContent ?? '')) === value);
}

async function closeFeishuPicker(element: HTMLElement): Promise<void> {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  element.blur();
  element.ownerDocument.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await nextFrames(1);
}

async function openFeishuPeriodPicker(
  root: Element,
  label: HTMLElement,
  input: HTMLElement,
): Promise<HTMLElement | null> {
  const document = input.ownerDocument;
  // 连续处理多条经历时，先清理上一条记录可能残留的弹层和焦点。
  if (visibleFeishuDropdown(document, '.atsx-date-picker-period-month-panel')) {
    await closeFeishuPicker(input);
    await waitFor(
      () => visibleFeishuDropdown(document, '.atsx-date-picker-period-month-panel') === null,
      250,
    );
  }

  const opened = () => visibleFeishuDropdown(document, '.atsx-date-picker-period-month-panel');
  const activate = (target: HTMLElement) => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    target.click();
  };

  // ATSX 的动态新增记录有时第一次只切换起止端焦点；分阶段尝试标签、
  // 整个区间控件和隐藏输入框，每一步都先观察是否已经成功打开。
  label.focus({ preventScroll: true });
  activate(label);
  if (await waitFor(() => opened() !== null, 350)) return opened();

  activate(root as HTMLElement);
  if (await waitFor(() => opened() !== null, 550)) return opened();

  input.focus({ preventScroll: true });
  activate(input);
  if (await waitFor(() => opened() !== null, OPEN_TIMEOUT_MS - 900)) return opened();
  return null;
}

/** 飞书把一段起止年月放在同一个控件内；descriptor.datePart 指定本次操作左端还是右端。 */
async function fillFeishuPeriodMonth(
  entry: ControlEntry,
  value: string,
  overwrite: boolean,
): Promise<ControlResult> {
  const presentValue = entry.descriptor.datePresentValue;
  const selectingPresent = Boolean(presentValue && normalizeLabel(value) === normalizeLabel(presentValue));
  const match = selectingPresent ? null : /^(\d{4})-(\d{2})$/.exec(value);
  if (!selectingPresent && !match) return failResult('PRECISION_MISMATCH', '年月区间需要 YYYY-MM 或已验证的“至今”选项');
  const year = match?.[1] ?? '';
  const month = match?.[2] ?? '';
  if (!selectingPresent && (Number(month) < 1 || Number(month) > 12)) {
    return failResult('PRECISION_MISMATCH', '月份不合法');
  }

  const current = readCurrentValue(entry).trim();
  if (selectingPresent && normalizeLabel(current) === normalizeLabel(presentValue!)) {
    return okResult('VALUE_ALREADY_EQUAL', '网页上已经选择了“至今”');
  }
  if (!selectingPresent && hasMonthValue(current, value)) return okResult('VALUE_ALREADY_EQUAL', '网页上已经是这个年月');
  if (current && !overwrite) return failResult('EXISTING_VALUE', '网页已有不同年月，已保留原值');

  const root = entry.primary.closest('.atsx-date-picker-period-month');
  const labels = root?.querySelectorAll<HTMLElement>('.atsx-date-picker-period-month-label') ?? [];
  const index = entry.descriptor.datePart?.edge === 'end' ? 1 : 0;
  const label = labels[index] ?? null;
  if (!root || labels.length !== 2 || !label || !isVisible(label)) {
    return failResult('UNSUPPORTED_WIDGET', '无法唯一定位年月区间的起止端');
  }

  const dropdown = await openFeishuPeriodPicker(root, label, entry.primary as HTMLElement);
  if (!dropdown) {
    await closeFeishuPicker(entry.primary as HTMLElement);
    return failResult('TIMEOUT', '年月选择器没有在 2 秒内打开');
  }

  const lists = [...dropdown.querySelectorAll<HTMLElement>('.atsx-date-picker-period-month-panel-list')]
    .filter(isVisible);
  if (lists.length !== 2) {
    await closeFeishuPicker(entry.primary);
    return failResult('UNSUPPORTED_WIDGET', '年月选择器的年份和月份列表不完整');
  }
  if (selectingPresent) {
    const presentOptions = [...lists[0]!.querySelectorAll<HTMLElement>('.atsx-date-picker-period-month-panel-list-item')]
      .filter(isVisible)
      .filter((item) => item.getAttribute('data-cy') === '-' || normalizeLabel(item.textContent ?? '') === normalizeLabel(presentValue!));
    if (presentOptions.length !== 1) {
      await closeFeishuPicker(entry.primary);
      return failResult('AMBIGUOUS_OPTION', '无法唯一定位“至今”选项');
    }
    presentOptions[0]!.click();
    await nextFrames(2);
    await delay(60);
    if (!entry.primary.isConnected) return failResult('STALE_PAGE', '选择“至今”后网页替换了节点');
    if (normalizeLabel(readCurrentValue(entry)) !== normalizeLabel(presentValue!)) {
      await closeFeishuPicker(entry.primary);
      return failResult('VALIDATION_FAILED', '选择“至今”后网页没有回显该状态');
    }
    await closeFeishuPicker(entry.primary);
    return okResult('FILLED_VERIFIED', '');
  }
  const years = exactDataValue(lists[0]!, '.atsx-date-picker-period-month-panel-list-item', year);
  const months = exactDataValue(lists[1]!, '.atsx-date-picker-period-month-panel-list-item', month);
  if (years.length !== 1 || months.length !== 1) {
    await closeFeishuPicker(entry.primary);
    return failResult('AMBIGUOUS_OPTION', '年月选择器中找不到唯一对应的年份或月份');
  }
  years[0]!.click();
  await nextFrames(1);
  months[0]!.click();
  await nextFrames(2);
  await delay(60);
  if (!entry.primary.isConnected) return failResult('STALE_PAGE', '选择年月后网页替换了节点');
  if (!hasMonthValue(readCurrentValue(entry), value)) {
    await closeFeishuPicker(entry.primary);
    return failResult('VALIDATION_FAILED', '选择年月后网页没有回显目标值');
  }
  await closeFeishuPicker(entry.primary);
  return okResult('FILLED_VERIFIED', '');
}

/** 飞书获奖时间使用只选择年份的九宫格面板。 */
async function fillFeishuYear(
  entry: ControlEntry,
  value: string,
  overwrite: boolean,
): Promise<ControlResult> {
  if (!/^\d{4}$/.test(value)) return failResult('PRECISION_MISMATCH', '年份选择器需要 YYYY');
  const input = entry.primary as HTMLInputElement;
  const current = readCurrentValue(entry).trim();
  if (current === value) return okResult('VALUE_ALREADY_EQUAL', '网页上已经是这个年份');
  if (current && !overwrite) return failResult('EXISTING_VALUE', '网页已有不同年份，已保留原值');

  input.focus({ preventScroll: true });
  input.click();
  const opened = await waitFor(
    () => visibleFeishuDropdown(input.ownerDocument, '.atsx-date-picker-panel-body-year') !== null,
    OPEN_TIMEOUT_MS,
  );
  if (!opened) return failResult('TIMEOUT', '年份选择器没有在 2 秒内打开');

  for (let step = 0; step < 20; step += 1) {
    const dropdown = visibleFeishuDropdown(input.ownerDocument, '.atsx-date-picker-panel-body-year');
    if (!dropdown) return failResult('STALE_PAGE', '年份选择器已意外关闭');
    const matches = exactDataValue(dropdown, '.atsx-date-picker-panel-body-cell-content', value);
    if (matches.length === 1) {
      matches[0]!.click();
      await nextFrames(2);
      await delay(60);
      if (readCurrentValue(entry).trim() !== value) {
        return failResult('VALIDATION_FAILED', '选择年份后网页没有回显目标值');
      }
      return okResult('FILLED_VERIFIED', '');
    }
    if (matches.length > 1) {
      await closeFeishuPicker(input);
      return failResult('AMBIGUOUS_OPTION', '年份面板出现了重复目标年份');
    }
    const rangeText = normalizeLabel(dropdown.querySelector('.atsx-date-picker-panel-header-title')?.textContent ?? '');
    const range = /^(\d{4})-(\d{4})$/.exec(rangeText);
    if (!range) {
      await closeFeishuPicker(input);
      return failResult('UNSUPPORTED_WIDGET', '无法读取年份面板范围');
    }
    const direction = Number(value) < Number(range[1]) ? 'prev' : 'next';
    const buttons = [...dropdown.querySelectorAll<HTMLElement>(`.atsx-date-picker-panel-header [data-cy="${direction}"]`)]
      .filter(isVisible);
    if (buttons.length !== 1) {
      await closeFeishuPicker(input);
      return failResult('AMBIGUOUS_OPTION', '无法唯一定位年份翻页按钮');
    }
    buttons[0]!.click();
    await nextFrames(1);
  }
  await closeFeishuPicker(input);
  return failResult('TIMEOUT', '翻页后仍未找到目标年份');
}

export async function fillDatePicker(
  entry: ControlEntry,
  value: string,
  overwrite: boolean,
): Promise<ControlResult> {
  if (entry.datePickerKind === 'beisen-phoenix-month') {
    return fillBeisenDatePicker(entry, value, overwrite);
  }
  if (entry.datePickerKind === 'beisen-phoenix-day') {
    return fillBeisenDayPicker(entry, value, overwrite);
  }
  if (entry.datePickerKind === 'feishu-period-month') {
    return fillFeishuPeriodMonth(entry, value, overwrite);
  }
  if (entry.datePickerKind === 'feishu-year') {
    return fillFeishuYear(entry, value, overwrite);
  }
  if (entry.datePickerKind === 'moka-month') return fillMokaDatePicker(entry, value, overwrite);
  return failResult('UNSUPPORTED_WIDGET', '没有可验证的日期组件驱动');
}

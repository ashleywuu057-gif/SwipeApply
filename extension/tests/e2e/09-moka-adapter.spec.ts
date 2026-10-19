import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  appUrl, DEMO_ORIGIN, findDemoTab, getState, importDemoProfile, launchExtension, runFill,
} from './helpers';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let appPage: Page;
let mokaPage: Page;
let profileVersionId: string;

test.beforeAll(async () => {
  const fixture = await launchExtension(mkdtempSync(path.join(tmpdir(), 'applykit-e2e-moka-')));
  context = fixture.context;
  appPage = await context.newPage();
  await appPage.goto(appUrl(fixture.extensionId));
  await importDemoProfile(appPage);
  profileVersionId = (await getState(appPage)).activeProfileVersionId!;
  mokaPage = await context.newPage();
  await mokaPage.goto(`${DEMO_ORIGIN}/moka-style.html`);
});

test.afterAll(async () => {
  await context?.close();
});

test('Moka 适配器新增足够记录、按顺序绑定并填写所有已存数据', async () => {
  const tab = await findDemoTab(appPage, 'moka-style.html');
  const { run, snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  expect(run.scan.adapterId).toBe('moka-campus-resume');
  expect(snapshot.report.phase).toBe('completed');
  expect(snapshot.report.fields.filter((field) => field.outcome === 'failed')).toHaveLength(0);
  const birthReport = snapshot.report.fields.find((field) => field.label.includes('出生'));
  expect(birthReport?.outcome, JSON.stringify(birthReport)).toBe('filled');

  await expect(mokaPage.locator('[data-record-section="education"]')).toHaveCount(2);
  const selectedValue = (name: string) => mokaPage.locator(`[name="${name}"]`)
    .evaluate((input) => input.parentElement?.querySelector('[data-select-display]')?.textContent ?? '');
  expect(await selectedValue('education-school-1')).toBe('示例理工大学');
  expect(await selectedValue('education-school-2')).toBe('示例工程学院');
  expect(await selectedValue('education-major-1')).toBe('软件工程');
  expect(await selectedValue('education-major-2')).toBe('计算机科学与技术');
  for (const [name, expected] of Object.entries({
    'education-start-year-1': '2024', 'education-start-month-1': '9',
    'education-end-year-1': '2027', 'education-end-month-1': '6',
    'education-start-year-2': '2020', 'education-start-month-2': '9',
    'education-end-year-2': '2024', 'education-end-month-2': '6',
  })) expect(await selectedValue(name), name).toBe(expected);

  await expect(mokaPage.locator('[data-record-section="projects"]')).toHaveCount(2);
  await expect(mokaPage.locator('[name="projects-name-1"]')).toHaveValue('示例知识检索助手');
  await expect(mokaPage.locator('[name="projects-name-2"]')).toHaveValue('示例任务管理平台');

  // 进行中的记录勾选「至今」；已结束的记录填年月且不勾选。
  await expect(mokaPage.locator('[name="projects-present-1"]')).toBeChecked();
  await expect(mokaPage.locator('[name="projects-present-2"]')).not.toBeChecked();
  expect(await selectedValue('projects-end-year-2')).toBe('2026');
  expect(await selectedValue('projects-end-month-2')).toBe('3');

  // 新增的模型字段：工作、薪资、默认城市、语言分项、奖项。
  await expect(mokaPage.locator('[name="work-company-1"]')).toHaveValue('星河网络（虚构）');
  await expect(mokaPage.locator('[name="work-present-1"]')).toBeChecked();
  await expect(mokaPage.locator('[name="current-salary"]')).toHaveValue('0');
  await expect(mokaPage.locator('[name="expected-salary"]')).toHaveValue('15k-20k');
  await expect(mokaPage.locator('[name="preferred-city"]')).toHaveValue('杭州');
  expect(await selectedValue('language-proficiency-1')).toBe('熟练');
  expect(await selectedValue('language-listening-1')).toBe('良好');
  expect(await selectedValue('language-reading-1')).toBe('熟练');
  expect(await selectedValue('award-year-1')).toBe('2025');
  expect(await selectedValue('award-month-1')).toBe('11');
  await expect(mokaPage.locator('[name="award-name-1"]')).toHaveValue('示例创新实践奖（虚构）');

  // 只读文本壳必须通过页面自己的年份/月份选择流程，而不是直接改 value。
  await expect(mokaPage.locator('[name="birth"]')).toHaveValue('2002-04 (age)');
  const received = await mokaPage.evaluate(() =>
    (window as unknown as { __mokaReceived: () => Record<string, string> }).__mokaReceived());
  expect(received['birth']).toBe('2002-04 (age)');
  expect(received['projects-present-1']).toBe('true');
  expect(received['education-start-month-1']).toBe('9');
  expect(received['award-month-1']).toBe('11');

  const second = await runFill(appPage, tab.tabId, profileVersionId);
  expect(second.snapshot.report.fields.map((field) => field.label))
    .toEqual(snapshot.report.fields.map((field) => field.label));
  expect(second.snapshot.report.fields.filter((field) => field.outcome === 'failed')).toHaveLength(0);
  await expect(mokaPage.locator('[data-record-section="education"]')).toHaveCount(2);
});

test('预先选择的月份不会被年份联动授权覆盖', async () => {
  await mokaPage.reload();
  await mokaPage.locator('[name="education-start-month-1"]').click();
  await mokaPage.locator('[data-demo-select]').filter({ has: mokaPage.locator('[name="education-start-month-1"]') })
    .getByText('4', { exact: true }).click();
  const tab = await findDemoTab(appPage, 'moka-style.html');
  await runFill(appPage, tab.tabId, profileVersionId);
  const received = await mokaPage.evaluate(() =>
    (window as unknown as { __mokaReceived: () => Record<string, string> }).__mokaReceived());
  expect(received['education-start-year-1']).toBe('2024');
  expect(received['education-start-month-1']).toBe('4');
});

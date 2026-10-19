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
let feishuPage: Page;
let profileVersionId: string;

test.beforeAll(async () => {
  const fixture = await launchExtension(mkdtempSync(path.join(tmpdir(), 'applykit-e2e-feishu-')));
  context = fixture.context;
  appPage = await context.newPage();
  await appPage.goto(appUrl(fixture.extensionId));
  await importDemoProfile(appPage);
  profileVersionId = (await getState(appPage)).activeProfileVersionId!;
  feishuPage = await context.newPage();
  await feishuPage.goto(`${DEMO_ORIGIN}/feishu-style.html`);
});

test.afterAll(async () => {
  await context?.close();
});

test('飞书招聘适配器识别 atsx 下拉、地区树、年月区间和年份控件', async () => {
  const tab = await findDemoTab(appPage, 'feishu-style.html');
  const { run, snapshot } = await runFill(appPage, tab.tabId, profileVersionId, 'scan');

  expect(run.scan.adapterId).toBe('feishu-jobs-atsx');
  expect(snapshot.descriptors.filter((field) => field.label === '开始时间')).not.toHaveLength(0);
  expect(snapshot.descriptors.filter((field) => field.label === '结束时间')).not.toHaveLength(0);
  expect(snapshot.descriptors.some((field) => field.label === '获奖时间' && field.datePrecision === 'year')).toBe(true);
  expect(snapshot.descriptors.some((field) => field.label === '所在地' && field.controlKind === 'combobox')).toBe(true);
  expect(snapshot.report.fields.some((field) => field.label === '请选择')).toBe(false);
});

test('飞书招聘适配器新增履历记录并通过网页控件完整回读', async () => {
  const tab = await findDemoTab(appPage, 'feishu-style.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  expect(snapshot.report.phase).toBe('completed');
  expect(snapshot.report.fields.filter((field) => field.outcome === 'failed')).toHaveLength(0);
  await expect(feishuPage.locator('[id="name"]')).toHaveValue('林示例');
  await expect(feishuPage.locator('[id="email"]')).toHaveValue('lin@example.com');
  await expect(feishuPage.locator('[id="age"]')).toHaveValue(/\d+/);
  await expect(feishuPage.locator('.atsx-select[id="gender"]')).toHaveAttribute('data-selected-value', '男');
  await expect(feishuPage.locator('.atsx-select[id="application_preferred_city_list"]')).toHaveAttribute('data-selected-value', '上海');
  await expect(feishuPage.locator('.atsx-select[id="current_city_code"]')).toHaveAttribute('data-selected-value', '杭州');
  await expect(feishuPage.locator('.atsx-select[id="hometown_city_code"]')).toHaveAttribute('data-selected-value', '吴中区');

  await expect(feishuPage.locator('[data-section="education"] .resumeEditForm-item')).toHaveCount(2);
  await expect(feishuPage.locator('.atsx-select[id="education[1].school"]')).toHaveAttribute('data-selected-value', '示例理工大学');
  await expect(feishuPage.locator('.atsx-select[id="education[1].degree"]')).toHaveAttribute('data-selected-value', '硕士研究生');
  await expect(feishuPage.locator('[id="education[2].fieldOfStudy"]')).toHaveValue('计算机科学与技术');
  await expect(feishuPage.locator('[data-name="education[1].date"] .atsx-date-picker-period-month-label').first()).toHaveText('2024-09');
  await expect(feishuPage.locator('[data-name="education[1].date"] .atsx-date-picker-period-month-label').nth(1)).toHaveText('2027-06');

  await expect(feishuPage.locator('[data-section="internship"] .resumeEditForm-item')).toHaveCount(1);
  await expect(feishuPage.locator('[id="internship[1].company"]')).toHaveValue('云笺科技（虚构）');
  await expect(feishuPage.locator('[data-section="project"] .resumeEditForm-item')).toHaveCount(2);
  await expect(feishuPage.locator('[id="project[2].name"]')).toHaveValue('示例任务管理平台');
  await expect(feishuPage.locator('[data-name="project[1].date"] .atsx-date-picker-period-month-label').nth(1)).toHaveText('至今');
  await expect(feishuPage.locator('[data-name="project[2].date"] .atsx-date-picker-period-month-label').first()).toHaveText('2026-01');
  await expect(feishuPage.locator('[data-name="project[2].date"] .atsx-date-picker-period-month-label').nth(1)).toHaveText('2026-03');
  await expect(feishuPage.locator('[name="award[1].date"]')).toHaveValue('2025');
  await expect(feishuPage.locator('.atsx-select[id="language[1].language"]')).toHaveAttribute('data-selected-value', '英语');
  await expect(feishuPage.locator('.atsx-select[id="language[1].proficiency"]')).toHaveAttribute('data-selected-value', '熟练');
  await expect(feishuPage.locator('[id="selfEvaluation"]')).toHaveValue(/AI 应用与后端开发/);

  const received = await feishuPage.evaluate(() =>
    (window as unknown as { __feishuReceived: () => Record<string, string> }).__feishuReceived());
  expect(received['education[1].date.start']).toBe('2024-09');
  expect(received['education[1].date.end']).toBe('2027-06');
  expect(received['current_city_code']).toBe('杭州');
  expect(received['hometown_city_code']).toBe('吴中区');
  expect(received.__emailInputType).toBe('insertText');
  expect(received['project[2].date.start']).toBe('2026-01');
  expect(received['project[2].date.end']).toBe('2026-03');
  expect(received['project[1].date.end']).toBe('至今');
  expect(snapshot.report.fields.find((field) => field.label === '没有工作经历')?.reasonCode)
    .toBe('VALUE_ALREADY_EQUAL');

  const second = await runFill(appPage, tab.tabId, profileVersionId);
  expect(second.snapshot.report.fields.filter((field) => field.outcome === 'failed')).toHaveLength(0);
  await expect(feishuPage.locator('[data-section="education"] .resumeEditForm-item')).toHaveCount(2);
  await expect(feishuPage.locator('[data-section="internship"] .resumeEditForm-item')).toHaveCount(1);
  await expect(feishuPage.locator('[data-section="project"] .resumeEditForm-item')).toHaveCount(2);
});

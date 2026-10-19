import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  appUrl, callBackground, DEMO_ORIGIN, findDemoTab, getState, importDemoProfile, launchExtension, runFill,
} from './helpers';

/** 新版飞书招聘（ud-formily，例如小鹏集团申请页）：分区、标签、按 formily-item 编号绑定、自动添加经历卡片。 */

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let appPage: Page;
let page: Page;
let profileVersionId: string;

test.beforeAll(async () => {
  const fixture = await launchExtension(mkdtempSync(path.join(tmpdir(), 'applykit-e2e-feishu-formily-')));
  context = fixture.context;
  appPage = await context.newPage();
  await appPage.goto(appUrl(fixture.extensionId));
  await importDemoProfile(appPage);
  profileVersionId = (await getState(appPage)).activeProfileVersionId!;
  page = await context.newPage();
  await page.goto(`${DEMO_ORIGIN}/feishu-formily-style.html`);
});

test.afterAll(async () => {
  await context?.close();
});

test('识别新版飞书表单：用专用适配器，标签不再被当成字段', async () => {
  const tab = await findDemoTab(appPage, 'feishu-formily-style.html');
  const { run, snapshot } = await runFill(appPage, tab.tabId, profileVersionId, 'scan');

  expect(run.scan.adapterId).toBe('feishu-jobs-formily');
  const labels = snapshot.descriptors.map((field) => field.label);
  expect(labels).toContain('姓名');
  expect(labels).toContain('邮箱');
  expect(labels).toContain('学校名称');
  expect(snapshot.descriptors.find((field) => field.label === '姓名')?.controlKind).toBe('text');
  // 以前每个标签都会多出一个"页面自定义控件"
  expect(snapshot.descriptors.filter((field) => field.controlKind === 'unsupported' && field.label === '姓名')).toHaveLength(0);
  expect(snapshot.report.fields.some((field) => field.label === '(未命名字段)')).toBe(false);
});

test('填写基本信息、补齐经历卡片并逐项回读', async () => {
  const tab = await findDemoTab(appPage, 'feishu-formily-style.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  expect(snapshot.report.phase).toBe('completed');
  expect(snapshot.report.fields.filter((field) => field.outcome === 'failed')).toHaveLength(0);

  // 项目卡片里也有 formily-item-name，基本信息要限定在「基本信息」分区里找
  const basic = page.locator('.applyFormModuleWrapper-windows', { has: page.locator('.applyFormModuleWrapper-text', { hasText: '基本信息' }) });
  await expect(basic.locator('#formily-item-name input')).toHaveValue('林示例');
  await expect(basic.locator('#formily-item-email input')).toHaveValue('lin@example.com');

  // 履历里 2 段教育：页面原有 1 张卡片，应自动添加 1 张
  const edu = page.locator('#formily-item-education_list [class*="apply-form-array-card__"]');
  await expect(edu).toHaveCount(2);
  await expect(edu.nth(0).locator('#formily-item-school input')).toHaveValue('示例理工大学');
  await expect(edu.nth(1).locator('#formily-item-school input')).toHaveValue('示例工程学院');
  // 学历：ud 只读下拉，选中后显示在 selectItem 里
  await expect(edu.nth(0).locator('#formily-item-degree .ud__select__selector__selectItem')).toHaveText('硕士研究生');
  await expect(edu.nth(1).locator('#formily-item-degree .ud__select__selector__selectItem')).toHaveText('本科');
  // 下拉都关掉了，没有留在页面上
  await expect(page.locator('.ud__select__dropdown')).toHaveCount(0);

  // 空分区：按履历条数添加卡片并填写
  const intern = page.locator('#formily-item-internship_list [class*="apply-form-array-card__"]');
  await expect(intern).toHaveCount(1);
  await expect(intern.first().locator('#formily-item-company input')).toHaveValue('云笺科技（虚构）');
  await expect(intern.first().locator('#formily-item-title input')).toHaveValue('后端开发实习生');

  const projects = page.locator('#formily-item-project_list [class*="apply-form-array-card__"]');
  await expect(projects).toHaveCount(2);
  await expect(projects.nth(1).locator('#formily-item-name input')).toHaveValue('示例任务管理平台');

  await expect(page.locator('#formily-item-award_list #formily-item-title input')).toHaveValue('示例创新实践奖（虚构）');
  await expect(page.locator('#formily-item-language_list #formily-item-language input')).toHaveValue('英语');

  // 再跑一次：不重复添加卡片，也不报失败
  const second = await runFill(appPage, tab.tabId, profileVersionId);
  expect(second.snapshot.report.fields.filter((field) => field.outcome === 'failed')).toHaveLength(0);
  await expect(edu).toHaveCount(2);
  await expect(intern).toHaveCount(1);
  await expect(projects).toHaveCount(2);
});

test('记住我补填的内容：履历里没有的字段手动填一次，下次自动填', async () => {
  await page.reload();
  const tab = await findDemoTab(appPage, 'feishu-formily-style.html');
  const marital = page.locator('#formily-item-marital');

  // 1. 第一次：履历里没有婚姻状况，留给你手动处理
  const first = await runFill(appPage, tab.tabId, profileVersionId);
  expect(first.snapshot.report.fields.find((f) => f.label === '婚姻状况')?.outcome).toBe('pending');
  await expect(marital.locator('.ud__select__selector__selectItem')).toHaveCount(0);

  // 2. 你在网页上手动选「未婚」
  await marital.locator('.ud__select__selector').dispatchEvent('mousedown');
  await page.locator('.ud__select__dropdown .ud__select__list__item', { hasText: '未婚' }).click();
  await expect(marital.locator('.ud__select__selector__selectItem')).toHaveText('未婚');

  // 3. 点「记住我补填的内容」：清单里有它、默认勾选；保存
  const captured = await callBackground<{ items: Array<{ label: string; value: string; suggested: boolean; sensitive: boolean; section: string; recordKey: string | null }>; origin: string }>(
    appPage, 'CAPTURE_MANUAL', { runId: first.run.runId });
  const item = captured.items.find((x) => x.label === '婚姻状况');
  expect(item?.value).toBe('未婚');
  // 婚姻状况是敏感信息：列出来，但默认不勾，要你主动选
  expect(item?.sensitive).toBe(true);
  expect(item?.suggested).toBe(false);
  await callBackground(appPage, 'SAVE_REMEMBERED', {
    origin: captured.origin,
    items: [{ section: item!.section, label: item!.label, recordKey: item!.recordKey, value: item!.value }],
  });
  const listed = await callBackground<{ items: Array<{ displayLabel: string; value: string }> }>(appPage, 'LIST_REMEMBERED', {});
  expect(listed.items.some((x) => x.displayLabel === '婚姻状况' && x.value === '未婚')).toBe(true);

  // 4. 刷新页面重新填：这次自动选上「未婚」
  await page.reload();
  const again = await runFill(appPage, (await findDemoTab(appPage, 'feishu-formily-style.html')).tabId, profileVersionId);
  const field = again.snapshot.report.fields.find((f) => f.label === '婚姻状况');
  expect(field?.outcome).toBe('filled');
  expect((field as { source?: { field?: string } } | undefined)?.source?.field).toBe('remembered');
  await expect(marital.locator('.ud__select__selector__selectItem')).toHaveText('未婚');
});

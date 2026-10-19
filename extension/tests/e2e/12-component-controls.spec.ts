import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { appUrl, callBackground, DEMO_ORIGIN, findDemoTab, getState, importDemoProfile, launchExtension, outcomeOf, runFill } from './helpers';

test.describe.configure({ mode: 'serial' });
let context: BrowserContext;
let app: Page;
let page: Page;
let profileId: string;

test.beforeAll(async () => {
  const fixture = await launchExtension(mkdtempSync(path.join(tmpdir(), 'applykit-components-')));
  context = fixture.context;
  app = await context.newPage();
  await app.goto(appUrl(fixture.extensionId));
  await importDemoProfile(app);
  profileId = (await getState(app)).activeProfileVersionId!;
  page = await context.newPage();
});
test.afterAll(async () => { await context?.close(); });

async function run(query = '') {
  await page.goto(`${DEMO_ORIGIN}/component-controls.html${query}`);
  const tab = await findDemoTab(app, 'component-controls.html');
  return runFill(app, tab.tabId, profileId);
}
async function state() {
  return page.evaluate(() => (window as unknown as {
    __componentFixture: () => { received: Record<string, string>; opened: Record<string, number>; adds: number };
  }).__componentFixture());
}

test('通用适配器识别无 input 控件，滚轮真实拖动、确认并在替换节点后验证', async () => {
  const { run: prepared, snapshot } = await run();
  expect(prepared.scan.adapterId).toBe('generic');
  for (const label of ['姓名', '性别', '所在城市', '出生日期', '公司名称', '职位名称']) {
    // 校园区也有同名公司字段；第一个是明确实习区。
    expect(outcomeOf(snapshot, label).outcome, JSON.stringify({ label, fields: snapshot.report.fields, state: await state() })).toBe('filled');
  }
  expect((await state()).received).toMatchObject({ gender: '男', city: '杭州市', birth: '2002-04-15', company: '云笺科技（虚构）' });
  expect((await state()).adds).toBe(0);
  expect((await state()).opened.nation).toBeUndefined();
  expect(outcomeOf(snapshot, '民族').reasonCode).toBe('REQUIRES_USER_ACTION');
  expect(outcomeOf(snapshot, '籍贯').reasonCode).toBe('UNSUPPORTED_WIDGET');
  expect(outcomeOf(snapshot, '起止时间').reasonCode).toBe('UNSUPPORTED_WIDGET');
  const report = await callBackground<{ notes: string[]; descriptors: Array<{ label: string; section: string }> }>(app, 'GET_RUN', { runId: prepared.runId });
  expect(report.notes.some((note) => note.includes('教育经历尚未展开'))).toBe(true);
  expect(report.descriptors.filter((field) => field.label === '公司名称').map((field) => field.section)).toEqual(['internships', 'unknown']);
  await expect(page.locator('[name="campus-company"]')).toHaveValue('');
  await expect(page.locator('.am-picker-popup')).toHaveCount(0);
});

test('改变表单布局和标题样式仍复用相同组件，不依赖公司专用 DOM', async () => {
  const { run: prepared, snapshot } = await run('?layout=fieldset');
  expect(prepared.scan.adapterId).toBe('generic');
  expect(outcomeOf(snapshot, '性别').outcome).toBe('filled');
  expect(outcomeOf(snapshot, '出生日期').outcome).toBe('filled');
  expect(snapshot.descriptors.filter((field) => field.label === '性别')).toHaveLength(1);
  expect((await state()).received.birth).toBe('2002-04-15');
});

test('用户添加经历后可重新识别整组，教育开始日期按约定补为 9 月 1 日', async () => {
  await run();
  await page.locator('#add-education').click();
  const tab = await findDemoTab(app, 'component-controls.html');
  const { snapshot } = await runFill(app, tab.tabId, profileId);
  await expect(page.locator('[name="school"]')).toHaveValue('示例理工大学');
  await expect(page.locator('[name="major"]')).toHaveValue('软件工程');
  expect(outcomeOf(snapshot, '学历层次').outcome).toBe('filled');
  expect(outcomeOf(snapshot, '入学日期').outcome).toBe('filled');
  expect((await state()).received.eduStart).toBe('2024-09-01');
  expect((await state()).opened.eduStart).toBe(1);
  expect((await state()).adds).toBe(1);
});

test('重复填写稳定识别已选值，保留用户原值，不触发新的选择', async () => {
  await run('?existing');
  const before = await state();
  expect(before.opened.gender).toBeUndefined();
  const tab = await findDemoTab(app, 'component-controls.html');
  const { snapshot } = await runFill(app, tab.tabId, profileId);
  expect(outcomeOf(snapshot, '性别').reasonCode).toBe('EXISTING_VALUE');
  expect(outcomeOf(snapshot, '出生日期').outcome).toBe('unchanged');
  expect((await state()).opened.birth).toBe(before.opened.birth);
  await expect(page.locator('#gender .am-list-extra')).toHaveText('女');
});

test('重复候选有歧义时取消滚轮，不提交任一选项', async () => {
  const { snapshot } = await run('?ambiguous');
  expect(outcomeOf(snapshot, '性别').reasonCode).toBe('AMBIGUOUS_OPTION');
  expect((await state()).received.gender).toBeUndefined();
  await expect(page.locator('#gender .am-list-extra')).toHaveText('请选择');
  await expect(page.locator('.am-picker-popup')).toHaveCount(0);
});

test('组件禁用状态不绕过，确认后页面拒绝更新也不报告成功', async () => {
  const { snapshot } = await run('?disabled&reject');
  expect(outcomeOf(snapshot, '性别').reasonCode).toBe('REQUIRES_USER_ACTION');
  expect((await state()).opened.gender).toBeUndefined();
  expect(outcomeOf(snapshot, '出生日期').reasonCode).toBe('VALIDATION_FAILED');
  expect(outcomeOf(snapshot, '所在城市').reasonCode).toBe('VALIDATION_FAILED');
  expect((await state()).received.birth).toBeUndefined();
});

test('用户已打开的弹层不被接管或取消', async () => {
  await page.goto(`${DEMO_ORIGIN}/component-controls.html?layout=fieldset`);
  await page.locator('#gender').click();
  const tab = await findDemoTab(app, 'component-controls.html');
  const { snapshot } = await runFill(app, tab.tabId, profileId);
  expect(outcomeOf(snapshot, '性别').reasonCode).toBe('REQUIRES_USER_ACTION');
  await expect(page.locator('.am-picker-popup')).toHaveCount(1);
  expect((await state()).received.gender).toBeUndefined();
  expect((await state()).opened.gender).toBe(1);
});

test('滚轮打开期间原字段发生变化时，取消选择并保留新值', async () => {
  const { snapshot } = await run('?edit-during-pick');
  expect(outcomeOf(snapshot, '性别').reasonCode).toBe('EXISTING_VALUE');
  await expect(page.locator('#gender .am-list-extra')).toHaveText('用户新选择');
  expect((await state()).received.gender).toBeUndefined();
  await expect(page.locator('.am-picker-popup')).toHaveCount(0);
});

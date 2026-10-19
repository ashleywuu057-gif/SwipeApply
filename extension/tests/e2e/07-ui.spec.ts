import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  appUrl, DEMO_ORIGIN, fieldIdOf, findDemoTab, getState, importDemoProfile, launchExtension, runFill,
} from './helpers';

/** 界面回归：弹窗、结果清单、履历编辑器。所有数字都来自真实运行结果。 */

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let appPage: Page;
let demoPage: Page;
let extensionId: string;
let runId = '';
const appErrors: string[] = [];

test.beforeAll(async () => {
  const fixture = await launchExtension(mkdtempSync(path.join(tmpdir(), 'applykit-e2e-ui-')));
  context = fixture.context;
  extensionId = fixture.extensionId;
  appPage = await context.newPage();
  appPage.on('pageerror', (error) => appErrors.push(error.message));
  await appPage.goto(appUrl(extensionId));
  await importDemoProfile(appPage);

  demoPage = await context.newPage();
  await demoPage.goto(`${DEMO_ORIGIN}/basic.html`);
  const tab = await findDemoTab(appPage, 'basic.html');
  const profileVersionId = (await getState(appPage)).activeProfileVersionId!;
  const result = await runFill(appPage, tab.tabId, profileVersionId);
  runId = result.run.runId;
});

test.afterAll(async () => {
  await context?.close();
});

test('结果清单显示真实统计，可按状态筛选并提供手动映射', async () => {
  await appPage.goto(appUrl(extensionId, `review/${runId}`));
  await expect(appPage.locator('#view-review .field-row').first()).toBeVisible();

  const state = await getState(appPage);
  const report = state.recentRuns.find((entry) => (entry as Record<string, unknown>)['id'] === runId) as
    | { fields: Array<{ outcome: string; label: string }> }
    | undefined;
  expect(report).toBeTruthy();

  const total = report!.fields.length;
  await expect(appPage.locator('#view-review .field-row')).toHaveCount(total);

  // 「全部 N」的数字与实际字段数一致。
  await expect(appPage.locator('.chip').first()).toHaveText(`全部 ${total}`);

  // 状态既有颜色也有文字。
  await expect(appPage.locator('.badge').first()).not.toBeEmpty();

  // 待处理筛选只显示待处理项，并带有源字段选择器。
  const pendingCount = report!.fields.filter((field) => field.outcome === 'pending').length;
  await appPage.getByRole('button', { name: new RegExp(`^待处理 ${pendingCount}$`) }).click();
  await expect(appPage.locator('#view-review .field-row')).toHaveCount(pendingCount);
  await expect(appPage.locator('.source-select').first()).toBeVisible();

  // 源字段选择器用中文显示，不要求用户输入代码路径。
  const options = await appPage.locator('.source-select').first().locator('option').allTextContents();
  expect(options.some((text) => text.includes('基础信息 / 姓名'))).toBe(true);
  expect(options.some((text) => text.includes('示例理工大学 / 专业'))).toBe(true);
  expect(options.join(' ')).not.toContain('education.');
});

test('定位按钮会在网页上高亮对应字段', async () => {
  // 上一条测试把筛选停在「待处理」，这里重新载入回到「全部」。
  await appPage.goto(appUrl(extensionId, `review/${runId}`));
  await appPage.reload();
  const row = appPage.locator('#view-review .field-row').filter({
    has: appPage.locator('.field-label', { hasText: /^姓名$/ }),
  });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: '定位' }).click();
  await expect(appPage.locator('.toast-success')).toBeVisible();
  await expect(demoPage.locator('#fullname')).toHaveAttribute('data-applykit-highlight', '1');
  expect(appErrors).toEqual([]);
});

test('扫描预览覆盖全部字段，并把可填项与待处理项分开统计', async () => {
  const tab = await findDemoTab(appPage, 'basic.html');
  const profileVersionId = (await getState(appPage)).activeProfileVersionId!;
  const { run, snapshot } = await runFill(appPage, tab.tabId, profileVersionId, 'scan');

  expect(snapshot.report.fields).toHaveLength(run.scan.fieldCount);
  expect(snapshot.summary['ready']).toBe(run.planned);
  expect(snapshot.summary['pending']).toBe(run.pending);
  expect((snapshot.summary['ready'] ?? 0) + (snapshot.summary['pending'] ?? 0)).toBeGreaterThan(0);
});

test('弹窗可以打开并显示当前履历与页面状态', async () => {
  const popup = await context.newPage();
  const errors: string[] = [];
  popup.on('pageerror', (error) => errors.push(error.message));
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  await expect(popup.locator('#current-profile')).toContainText('虚构演示');
  await expect(popup.locator('#current-site')).toContainText('127.0.0.1:4173');
  await expect(popup.locator('#btn-fill')).toBeEnabled();
  await expect(popup.locator('#btn-stop')).toBeDisabled();

  // 扫描当前页面：统计数字来自真实执行结果。
  await popup.locator('#btn-scan').click();
  await expect(popup.locator('#status-line')).toContainText('扫描完成');
  await expect(popup.locator('.summary-total')).toContainText(/本轮共 \d+ 个字段/);
  await expect(popup.locator('#summary')).toContainText('可自动填写');
  await expect(popup.locator('#summary')).toContainText('已填写');
  expect(errors).toEqual([]);
  await popup.close();
});

test('编辑履历保存后生成新版本，历史版本保留', async () => {
  await appPage.goto(appUrl(extensionId, 'profiles'));
  const before = await getState(appPage);
  await appPage.getByRole('button', { name: '编辑', exact: true }).first().click();
  await expect(appPage.locator('#btn-save-profile')).toBeVisible();

  // 修改现居城市并保存。
  const cityField = appPage.locator('.form-field', { hasText: '现居城市' }).locator('input');
  await cityField.fill('北京');
  await cityField.blur();
  await appPage.locator('#btn-save-profile').click();

  await expect.poll(async () => (await getState(appPage)).profiles.length).toBe(before.profiles.length + 1);
  const after = await getState(appPage);
  expect(after.activeProfileVersionId).not.toBe(before.activeProfileVersionId);

  // 旧版本没有被改写。
  const original = after.profiles.find((entry) => entry.profileVersionId === before.activeProfileVersionId) as
    | { data: { personal: { currentCity: string } } }
    | undefined;
  expect(original?.data.personal.currentCity).toBe('杭州');
});

test('保存前的格式检查会拦截错误数据', async () => {
  await appPage.goto(appUrl(extensionId, 'profiles'));
  await appPage.getByRole('button', { name: '编辑', exact: true }).first().click();
  const emailField = appPage.locator('.form-field', { hasText: '邮箱' }).locator('input');
  await emailField.fill('不是邮箱');
  await emailField.blur();

  const before = await getState(appPage);
  await appPage.locator('#btn-save-profile').click();
  await expect(appPage.locator('#editor-errors .error')).toContainText('邮箱');
  expect((await getState(appPage)).profiles.length).toBe(before.profiles.length);
});

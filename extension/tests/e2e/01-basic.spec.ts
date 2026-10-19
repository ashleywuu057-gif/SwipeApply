import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  appUrl, callBackground, DEMO_ORIGIN, demoReceived, findDemoTab, getState, importDemoProfile,
  launchExtension, outcomeOf, runFill, waitForRun, type RunSnapshot,
} from './helpers';

/** E01 / E05 / E06 / E08：基础填写、保留用户内容、后台继续、禁止操作的控件。 */

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let appPage: Page;
let demoPage: Page;
let extensionId: string;
let profileVersionId: string;

test.beforeAll(async () => {
  const fixture = await launchExtension(mkdtempSync(path.join(tmpdir(), 'applykit-e2e-basic-')));
  context = fixture.context;
  extensionId = fixture.extensionId;

  appPage = await context.newPage();
  await appPage.goto(appUrl(extensionId));
  await importDemoProfile(appPage);
  profileVersionId = (await getState(appPage)).activeProfileVersionId!;

  demoPage = await context.newPage();
  await demoPage.goto(`${DEMO_ORIGIN}/basic.html?jobId=demo-basic-001`);
});

test.afterAll(async () => {
  await context?.close();
});

test('E01 填写 basic 页面：网页控件值与页面事件状态都正确', async () => {
  const tab = await findDemoTab(appPage, 'basic.html');
  const started = Date.now();
  const { run, snapshot } = await runFill(appPage, tab.tabId, profileVersionId);
  const elapsed = Date.now() - started;

  expect(run.scan.jobCandidate?.company).toBe('星帆科技（演示）');
  expect(run.scan.jobCandidate?.externalJobId).toBe('demo-basic-001');
  expect(snapshot.report.modelCalls).toBe(0);
  expect(snapshot.report.phase).toBe('completed');

  // 网页控件的实际值。
  await expect(demoPage.locator('#fullname')).toHaveValue('林示例');
  await expect(demoPage.locator('#email')).toHaveValue('lin@example.com');
  await expect(demoPage.locator('#phone')).toHaveValue('00000000000');
  await expect(demoPage.locator('#homepage')).toHaveValue('https://example.com/portfolio');
  await expect(demoPage.locator('#availability')).toHaveValue('随时到岗');
  await expect(demoPage.locator('#months')).toHaveValue('6个月');
  await expect(demoPage.locator('input[name="weekdays"][value="5天"]')).toBeChecked();
  await expect(demoPage.locator('#intro')).toHaveValue(/AI 应用与后端开发/);

  // 页面自己的事件状态：证明不是只改了视觉值。
  const received = await demoReceived(demoPage);
  expect(received['fullname']).toBe('林示例');
  expect(received['email']).toBe('lin@example.com');
  expect(received['months']).toBe('6个月');
  expect(received['weekdays']).toBe('5天');

  // 默认值被保留，相同值计为未改动。
  await expect(demoPage.locator('#city')).toHaveValue('上海');
  expect(outcomeOf(snapshot, '现居城市')).toEqual({ outcome: 'preserved', reasonCode: 'EXISTING_VALUE' });
  await expect(demoPage.locator('#englishname')).toHaveValue('Example Lin');
  expect(outcomeOf(snapshot, '英文名')).toEqual({ outcome: 'unchanged', reasonCode: 'VALUE_ALREADY_EQUAL' });

  // 统计与字段结果一致。
  const total = Object.values(snapshot.summary).reduce((sum, value) => sum + value, 0);
  expect(total).toBe(snapshot.report.fields.length);
  expect(snapshot.summary['filled']).toBeGreaterThanOrEqual(8);
  expect(elapsed).toBeLessThan(15_000);
});

test('E08 声明、附件、密码与隐藏字段不被操作，完整出生日期可填', async () => {
  const state = await getState(appPage);
  const latestRun = state.recentRuns.at(-1) as unknown as RunSnapshot['report'];
  const snapshot = await callBackground<RunSnapshot>(appPage, 'GET_RUN', { runId: latestRun.id });

  expect(outcomeOf(snapshot, '我同意接收职位推荐邮件').outcome).toBe('pending');
  expect(outcomeOf(snapshot, '我同意接收职位推荐邮件').reasonCode).toBe('UNSUPPORTED_WIDGET');
  await expect(demoPage.locator('#mail-consent')).not.toBeChecked();

  expect(outcomeOf(snapshot, '出生日期').reasonCode).toBe('FILLED_VERIFIED');
  await expect(demoPage.locator('#birthdate')).toHaveValue('2002-04-15');

  // 密码与隐藏字段不进入报告，也没有被改动。
  const labels = snapshot.report.fields.map((field) => field.label);
  expect(labels.some((label) => label.includes('密码'))).toBe(false);
  await expect(demoPage.locator('#github')).toHaveValue('');
  expect(outcomeOf(snapshot, 'GitHub').reasonCode).toBe('SOURCE_MISSING');

  // 多个意向岗位不会被擅自选一个。
  await expect(demoPage.locator('#target-role')).toHaveValue('');
  expect(outcomeOf(snapshot, '意向岗位').reasonCode).toBe('REQUIRES_USER_ACTION');

  // 页面的提交按钮没有被点击。
  await expect(demoPage.locator('#demo-success')).toBeHidden();
});

test('E01 重复运行不改变已填内容，也不产生重复副作用', async () => {
  const tab = await findDemoTab(appPage, 'basic.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);
  expect(outcomeOf(snapshot, '姓名')).toEqual({ outcome: 'unchanged', reasonCode: 'VALUE_ALREADY_EQUAL' });
  await expect(demoPage.locator('#fullname')).toHaveValue('林示例');
  const received = await demoReceived(demoPage);
  expect(received['fullname']).toBe('林示例');
});

test('E05 扫描后用户编辑的内容会被保留', async () => {
  await demoPage.reload();
  const tab = await findDemoTab(appPage, 'basic.html');

  // 先扫描，再由用户输入，最后填写。
  await runFill(appPage, tab.tabId, profileVersionId, 'scan');
  await demoPage.locator('#fullname').fill('用户自己写的姓名');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  await expect(demoPage.locator('#fullname')).toHaveValue('用户自己写的姓名');
  expect(outcomeOf(snapshot, '姓名')).toEqual({ outcome: 'preserved', reasonCode: 'EXISTING_VALUE' });
});

test('E05 连续点击不会创建并行运行', async () => {
  await demoPage.reload();
  const tab = await findDemoTab(appPage, 'basic.html');
  const [first, second] = await Promise.all([
    callBackground<{ runId: string; reused: boolean }>(appPage, 'PREPARE_RUN', {
      targetTabId: tab.tabId, profileVersionId, mode: 'fill', applicationId: null,
    }),
    appPage.waitForTimeout(30).then(() =>
      callBackground<{ runId: string; reused: boolean }>(appPage, 'PREPARE_RUN', {
        targetTabId: tab.tabId, profileVersionId, mode: 'fill', applicationId: null,
      }),
    ),
  ]);
  expect(second.runId).toBe(first.runId);
  expect(second.reused).toBe(true);
  await waitForRun(appPage, first.runId);
});

test('E06 关闭工作台页面后填写继续；取消后不再执行后续动作', async () => {
  await demoPage.reload();
  const tab = await findDemoTab(appPage, 'basic.html');

  const run = await callBackground<{ runId: string }>(appPage, 'PREPARE_RUN', {
    targetTabId: tab.tabId, profileVersionId, mode: 'fill', applicationId: null,
  });
  // 立刻请求停止：已完成的保留，后续动作不再执行。
  await callBackground(appPage, 'CANCEL_RUN', { runId: run.runId });
  const snapshot = await waitForRun(appPage, run.runId);
  expect(['cancelled', 'completed']).toContain(snapshot.report.phase);

  // 另一轮：关闭发起页面后填写仍然完成（执行发生在目标页面里）。
  await demoPage.reload();
  const helper = await context.newPage();
  await helper.goto(appUrl(extensionId));
  const tab2 = await findDemoTab(helper, 'basic.html');
  const run2 = await callBackground<{ runId: string }>(helper, 'PREPARE_RUN', {
    targetTabId: tab2.tabId, profileVersionId, mode: 'fill', applicationId: null,
  });
  await helper.close();
  await expect.poll(async () => (await demoPage.locator('#fullname').inputValue()), { timeout: 20_000 }).toBe('林示例');
  const snapshot2 = await waitForRun(appPage, run2.runId);
  expect(snapshot2.report.phase).toBe('completed');
});

test('异步校验失败时报告为失败，不谎报成功', async () => {
  await demoPage.reload();
  await demoPage.locator('#demo-async-invalid').check();
  const tab = await findDemoTab(appPage, 'basic.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);
  expect(outcomeOf(snapshot, '邮箱')).toEqual({ outcome: 'failed', reasonCode: 'VALIDATION_FAILED' });
  await demoPage.locator('#demo-async-invalid').uncheck();
});

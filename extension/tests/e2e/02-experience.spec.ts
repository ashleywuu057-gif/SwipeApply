import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  appUrl, callBackground, DEMO_ORIGIN, demoReceived, findDemoTab, getState, importDemoProfile,
  launchExtension, runFill, waitForRun,
} from './helpers';

/** E02 / E07：两段教育不串位、分拆年月、异步下拉、新增经历恰好一次、导航后停止旧计划。 */

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let appPage: Page;
let demoPage: Page;
let profileVersionId: string;

test.beforeAll(async () => {
  const fixture = await launchExtension(mkdtempSync(path.join(tmpdir(), 'applykit-e2e-exp-')));
  context = fixture.context;
  appPage = await context.newPage();
  await appPage.goto(appUrl(fixture.extensionId));
  await importDemoProfile(appPage);
  profileVersionId = (await getState(appPage)).activeProfileVersionId!;
  demoPage = await context.newPage();
  await demoPage.goto(`${DEMO_ORIGIN}/experience.html`);
});

test.afterAll(async () => {
  await context?.close();
});

test('E02 两段教育各就各位，年月分开填写，实习与项目正确', async () => {
  const tab = await findDemoTab(appPage, 'experience.html');
  const started = Date.now();
  const { run, snapshot } = await runFill(appPage, tab.tabId, profileVersionId);
  const elapsed = Date.now() - started;

  expect(snapshot.report.phase).toBe('completed');
  expect(run.notes.join(' ')).toContain('新增了 1 条');

  // 硕士段与本科段不串位。
  await expect(demoPage.locator('#edu-master-school')).toHaveValue('示例理工大学');
  await expect(demoPage.locator('#edu-master-major')).toHaveValue('软件工程');
  await expect(demoPage.locator('#edu-bachelor-school')).toHaveValue('示例工程学院');
  await expect(demoPage.locator('#edu-bachelor-major')).toHaveValue('计算机科学与技术');

  // 分拆年/月与原生 month 控件。
  await expect(demoPage.locator('#edu-master-start-year')).toHaveValue('2024');
  await expect(demoPage.locator('#edu-master-start-month')).toHaveValue('9');
  await expect(demoPage.locator('#edu-master-end')).toHaveValue('2027-06');
  await expect(demoPage.locator('#edu-bachelor-start-year')).toHaveValue('2020');
  await expect(demoPage.locator('#edu-bachelor-start-month')).toHaveValue('9');
  await expect(demoPage.locator('#edu-bachelor-end')).toHaveValue('2024-06');

  // 起止时间不交叉。
  const received = await demoReceived(demoPage);
  expect(received['edu-master-start-year']).toBe('2024');
  expect(received['edu-bachelor-start-year']).toBe('2020');
  expect(Number(received['edu-master-end']!.slice(0, 4))).toBeGreaterThan(Number(received['edu-master-start-year']));

  // 实习：ARIA combobox 异步选项。
  await expect(demoPage.locator('#intern-company')).toHaveValue('云笺科技（虚构）');
  await expect(demoPage.locator('#intern-city')).toHaveValue('杭州');
  await expect(demoPage.locator('#intern-start')).toHaveValue('2026-02');
  await expect(demoPage.locator('#intern-end')).toHaveValue('2026-07');
  expect(received['intern-city']).toBe('杭州');

  // 项目：第一段写入后节点被替换，仍确认成功；第二段来自新增的记录。
  await expect(demoPage.locator('#project-name-1')).toHaveValue('示例知识检索助手');
  await expect(demoPage.locator('#project-end-1')).toHaveValue('至今');
  await expect(demoPage.locator('#project-name-2')).toHaveValue('示例任务管理平台');
  await expect(demoPage.locator('#project-role-2')).toHaveValue('后端开发');
  expect(received['project-name-1']).toBe('示例知识检索助手');
  expect(received['project-name-2']).toBe('示例任务管理平台');

  // 全部字段都有确定结果，没有失败。
  expect(snapshot.summary['failed']).toBe(0);
  expect(elapsed).toBeLessThan(15_000);
});

test('E02 再次运行不会重复新增经历', async () => {
  const before = await demoPage.locator('#project-records .record').count();
  const tab = await findDemoTab(appPage, 'experience.html');
  const { run } = await runFill(appPage, tab.tabId, profileVersionId);
  expect(run.notes.join(' ')).not.toContain('新增了');
  expect(await demoPage.locator('#project-records .record').count()).toBe(before);
});

test('E07 页面导航后旧计划停止，不会写到别的页面', async () => {
  await demoPage.reload();
  const tab = await findDemoTab(appPage, 'experience.html');
  // 在填写进行中导航，验证旧计划不会继续执行，并且这一轮不会永远停在「填写中」。
  const [run] = await Promise.all([
    callBackground<{ runId: string }>(appPage, 'PREPARE_RUN', {
      targetTabId: tab.tabId,
      profileVersionId,
      mode: 'fill',
      applicationId: null,
    }),
    demoPage.waitForTimeout(120).then(() => demoPage.goto(`${DEMO_ORIGIN}/basic.html`)),
  ]);

  const snapshot = await waitForRun(appPage, run.runId, 30_000);
  expect(snapshot.report.finishedAt).not.toBeNull();
  expect(['interrupted', 'completed', 'cancelled']).toContain(snapshot.report.phase);

  // 新页面上的字段不会被上一轮的计划写入。
  await expect(demoPage.locator('#fullname')).toHaveValue('');
  await expect(demoPage.locator('#email')).toHaveValue('');
  const received = await demoReceived(demoPage);
  expect(Object.keys(received)).toHaveLength(0);
});

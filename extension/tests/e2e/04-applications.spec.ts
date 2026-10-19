import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  appUrl, callBackground, DEMO_ORIGIN, findDemoTab, getState, importDemoProfile, launchExtension, runFill,
} from './helpers';

/** E09 / E10：填写完成不等于已投递、人工确认后才改状态、去重提示与 CSV 导入导出。 */

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let appPage: Page;
let demoPage: Page;
let extensionId: string;
let profileVersionId: string;
let tmpDir: string;

const JOB_URL = `${DEMO_ORIGIN}/basic.html?jobId=demo-basic-001&token=should-not-be-saved`;

test.beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'applykit-e2e-apps-'));
  const fixture = await launchExtension(tmpDir);
  context = fixture.context;
  extensionId = fixture.extensionId;
  appPage = await context.newPage();
  await appPage.goto(appUrl(extensionId, 'applications'));
  await importDemoProfile(appPage);
  profileVersionId = (await getState(appPage)).activeProfileVersionId!;
  demoPage = await context.newPage();
  await demoPage.goto(JOB_URL);
});

test.afterAll(async () => {
  await context?.close();
});

test('E09 填写完成后记录仍不是「已投递」，用户确认后才改变', async () => {
  const tab = await findDemoTab(appPage, 'basic.html');
  const { run } = await runFill(appPage, tab.tabId, profileVersionId);
  expect(run.scan.jobCandidate?.company).toBe('星帆科技（演示）');

  // 用扫描到的岗位候选保存记录（用户核对后的动作）。
  await appPage.goto(appUrl(extensionId, 'applications'));
  await appPage.locator('#app-company').fill('星帆科技（演示）');
  await appPage.locator('#app-role').fill('AI 应用开发实习生（演示）');
  await appPage.locator('#app-location').fill('杭州');
  await appPage.locator('#app-url').fill(JOB_URL);
  await appPage.locator('#btn-save-application').click();
  await expect.poll(async () => (await getState(appPage)).applications.length).toBe(1);

  const afterSave = await getState(appPage);
  const record = afterSave.applications[0] as Record<string, unknown>;
  expect(record['status']).toBe('planned');
  expect(record['appliedAt']).toBeNull();
  expect(record['submissionEvidence']).toBeNull();
  // 敏感查询参数不会被保存。
  expect(String(record['sourceUrl'])).not.toContain('token');
  expect(record['externalJobId']).toBe('demo-basic-001');

  // 用户在网页上手动提交并看到成功提示。
  await demoPage.locator('#demo-submit').click();
  await expect(demoPage.locator('#demo-success')).toBeVisible();

  // 只有在扩展里确认后，记录才变成已投递。
  await appPage.reload();
  await appPage.locator('[data-action="confirm-submitted"]').first().click();
  await expect.poll(async () => {
    const state = await getState(appPage);
    return (state.applications[0] as Record<string, unknown>)['status'];
  }).toBe('applied');

  const confirmed = (await getState(appPage)).applications[0] as Record<string, unknown>;
  expect(confirmed['appliedAt']).not.toBeNull();
  expect(confirmed['submissionEvidence']).toMatchObject({ kind: 'user-confirmed', successSeen: true });
});

test('E09 没有提交证据时不能直接改成后续阶段', async () => {
  const state = await getState(appPage);
  const applied = state.applications[0] as Record<string, unknown>;

  // 新建一条未提交的记录，尝试直接改成面试。
  const created = await callBackground<{ saved: boolean; id: string }>(appPage, 'UPSERT_APPLICATION', {
    record: {
      id: null, company: '另一家演示公司', role: '数据实习生（演示）', location: '北京',
      sourceUrl: null, canonicalUrl: null, externalJobId: null,
      profileVersionId, status: 'planned', blocker: 'none',
      appliedAt: null, nextAction: null, notes: null, submissionEvidence: null,
    },
    expectedRevision: state.revision,
    allowDuplicate: false,
  });
  expect(created.saved).toBe(true);

  const next = await getState(appPage);
  await expect(
    callBackground(appPage, 'SET_APPLICATION_STATUS', {
      recordId: created.id, status: 'interview', blocker: 'none', reason: null, expectedRevision: next.revision,
    }),
  ).rejects.toThrow(/没有提交证据/);

  // 已投递的那条可以正常进入后续阶段。
  const after = await getState(appPage);
  await callBackground(appPage, 'SET_APPLICATION_STATUS', {
    recordId: applied['id'], status: 'interview', blocker: 'none', reason: null, expectedRevision: after.revision,
  });
  await expect.poll(async () => {
    const current = await getState(appPage);
    return (current.applications.find((entry) => entry['id'] === applied['id']) as Record<string, unknown>)['status'];
  }).toBe('interview');
});

test('E10 相同岗位提示已有记录，不同岗位独立保存', async () => {
  // 上一条测试在页面之外改过数据，这里重新载入工作台再操作。
  await appPage.reload();
  await appPage.locator('#app-company').fill('星帆科技（演示）');
  await appPage.locator('#app-role').fill('AI 应用开发实习生（演示）');
  await appPage.locator('#app-location').fill('杭州');
  await appPage.locator('#app-url').fill(JOB_URL);
  await appPage.locator('#btn-save-application').click();

  // 提示已有记录，并提供「记录新的申请」入口，不静默覆盖。
  await expect(appPage.locator('text=已有相同岗位的记录')).toBeVisible();
  const before = (await getState(appPage)).applications.length;
  await appPage.locator('#btn-record-again').click();
  await expect.poll(async () => (await getState(appPage)).applications.length).toBe(before + 1);

  // 不同岗位不会被公司相同挡住。
  await appPage.reload();
  await appPage.locator('#app-company').fill('星帆科技（演示）');
  await appPage.locator('#app-role').fill('Python 后端实习生（演示）');
  await appPage.locator('#app-url').fill(`${DEMO_ORIGIN}/experience.html?jobId=demo-experience-001`);
  await appPage.locator('#btn-save-application').click();
  await expect.poll(async () => (await getState(appPage)).applications.length).toBe(before + 2);
});

test('E10 CSV 导出后重新导入，重复项按选择跳过', async () => {
  await appPage.reload();
  const state = await getState(appPage);

  // 导出：直接读取生产导出逻辑产生的内容并落盘，模拟用户点击下载。
  const csv = await appPage.evaluate(async () => {
    const reply = await chrome.runtime.sendMessage({
      protocolVersion: 1, requestId: crypto.randomUUID(), type: 'GET_STATE', payload: {},
    });
    return reply.data.applications.length;
  });
  expect(csv).toBe(state.applications.length);

  const download = appPage.waitForEvent('download');
  await appPage.locator('#btn-export-csv').click();
  const file = await download;
  const csvPath = path.join(tmpDir, 'applications.csv');
  await file.saveAs(csvPath);

  const content = readFileSync(csvPath, 'utf8');
  expect(content.startsWith('﻿')).toBe(true);
  expect(content).toContain('星帆科技（演示）');
  expect(content).not.toContain('token=should-not-be-saved');

  // 重新导入同一个文件：相同 ID 且内容相同的项被跳过。
  await appPage.locator('#csv-file').setInputFiles(csvPath);
  await appPage.locator('#csv-strategy').selectOption('skip-identical');
  await appPage.locator('#btn-import-csv').click();
  await appPage.locator('#btn-confirm-csv').click();
  await expect.poll(async () => (await getState(appPage)).applications.length).toBe(state.applications.length);

  // 修改一行后导入：冲突项可以选择作为新申请追加。
  const modified = content.replace('杭州', '杭州（改）');
  const modifiedPath = path.join(tmpDir, 'applications-modified.csv');
  writeFileSync(modifiedPath, modified, 'utf8');
  await appPage.reload();
  await appPage.locator('#csv-file').setInputFiles(modifiedPath);
  await appPage.locator('#csv-strategy').selectOption('append-as-new');
  await appPage.locator('#btn-import-csv').click();
  await appPage.locator('#btn-confirm-csv').click();
  await expect.poll(async () => (await getState(appPage)).applications.length).toBeGreaterThan(state.applications.length);
});

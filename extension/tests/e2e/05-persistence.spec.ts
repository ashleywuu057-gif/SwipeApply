import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  appUrl, callBackground, DEMO_ORIGIN, findDemoTab, getState, importDemoProfile, launchExtension,
  ROOT, runFill,
} from './helpers';

/** E11 / E12：备份恢复到新的测试环境、浏览器重启与扩展重载后数据仍在且不重复执行旧任务。 */

test.describe.configure({ mode: 'serial' });

const tmpDir = mkdtempSync(path.join(tmpdir(), 'applykit-e2e-persist-'));
const profileDir = path.join(tmpDir, 'profile-a');
const restoreDir = path.join(tmpDir, 'profile-b');
let backupPath = '';

async function seedData(page: Page): Promise<{ profileVersionId: string }> {
  await importDemoProfile(page);
  const profileVersionId = (await getState(page)).activeProfileVersionId!;
  const state = await getState(page);
  await callBackground(page, 'UPSERT_APPLICATION', {
    record: {
      id: null, company: '星帆科技（演示）', role: 'AI 应用开发实习生（演示）', location: '杭州',
      sourceUrl: `${DEMO_ORIGIN}/basic.html?jobId=demo-basic-001`,
      canonicalUrl: `${DEMO_ORIGIN}/basic.html?jobId=demo-basic-001`,
      externalJobId: 'demo-basic-001', profileVersionId, status: 'planned', blocker: 'none',
      appliedAt: null, nextAction: '准备笔试', notes: null, submissionEvidence: null,
    },
    expectedRevision: state.revision,
    allowDuplicate: false,
  });
  return { profileVersionId };
}

test('E12 浏览器重启后履历、记录与规则仍在，旧任务不会重复执行', async () => {
  const first = await launchExtension(profileDir);
  const appPage = await first.context.newPage();
  await appPage.goto(appUrl(first.extensionId));
  const { profileVersionId } = await seedData(appPage);

  // 制造一条规则：在 edge-cases 页面把陌生标签对应到邮箱。
  const demoPage = await first.context.newPage();
  await demoPage.goto(`${DEMO_ORIGIN}/edge-cases.html`);
  const tab = await findDemoTab(appPage, 'edge-cases.html');
  const { run, snapshot } = await runFill(appPage, tab.tabId, profileVersionId);
  const pending = snapshot.report.fields.find((field) => field.label === '联系信箱入口')!;
  await callBackground(appPage, 'RETRY_FIELD', {
    runId: run.runId, fieldId: pending.fieldId,
    source: { section: 'personal', field: 'email' }, remember: true, overwriteExisting: false,
  });

  const before = await getState(appPage);
  expect(before.profiles).toHaveLength(1);
  expect(before.applications).toHaveLength(1);
  expect(before.mappings).toHaveLength(1);

  // 导出完整备份，供下一个测试在全新环境恢复。
  await appPage.goto(appUrl(first.extensionId, 'backup'));
  const download = appPage.waitForEvent('download');
  await appPage.locator('#btn-export-backup').click();
  backupPath = path.join(tmpDir, 'backup.json');
  await (await download).saveAs(backupPath);

  await first.context.close();

  // 重新启动浏览器（同一个用户目录）。
  const second = await launchExtension(profileDir);
  const restored = await second.context.newPage();
  await restored.goto(appUrl(second.extensionId));
  const after = await getState(restored);
  expect(after.profiles).toHaveLength(1);
  expect(after.applications).toHaveLength(1);
  expect(after.mappings).toHaveLength(1);
  expect(after.activeProfileVersionId).toBe(profileVersionId);

  // 上一轮运行不会在新会话里自动重放：演示页面重新打开后仍是空的。
  const freshDemo = await second.context.newPage();
  await freshDemo.goto(`${DEMO_ORIGIN}/edge-cases.html`);
  await restored.waitForTimeout(1000);
  await expect(freshDemo.locator('#applicant-name')).toHaveValue('');
  await expect(freshDemo.locator('#contact-inbox')).toHaveValue('');

  // 旧运行被标记为已结束，不会一直停留在「填写中」。
  const oldRun = after.recentRuns.find((entry) => (entry as Record<string, unknown>)['id'] === run.runId) as Record<string, unknown> | undefined;
  expect(oldRun?.['finishedAt']).not.toBeNull();

  await second.context.close();
});

test('E11 完整备份可以在一个全新的扩展环境中恢复', async () => {
  expect(backupPath).not.toBe('');
  const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as {
    kind: string;
    state: { profiles: unknown[]; applications: unknown[]; mappings: unknown[] };
  };
  expect(backup.kind).toBe('applykit-backup');
  expect(backup.state.profiles).toHaveLength(1);

  const fresh = await launchExtension(restoreDir);
  const page = await fresh.context.newPage();
  await page.goto(appUrl(fresh.extensionId, 'backup'));

  // 新环境一开始是空的。
  const empty = await getState(page);
  expect(empty.profiles).toHaveLength(0);
  expect(empty.applications).toHaveLength(0);

  await page.locator('#backup-file').setInputFiles(backupPath);
  await page.locator('#btn-check-backup').click();
  await page.locator('#btn-restore-backup').click();

  await expect.poll(async () => (await getState(page)).profiles.length).toBe(1);
  const restored = await getState(page);
  expect(restored.applications).toHaveLength(1);
  expect(restored.mappings).toHaveLength(1);
  expect(restored.activeProfileVersionId).not.toBeNull();

  // 恢复后的履历可以直接用于填写。
  const demoPage = await fresh.context.newPage();
  await demoPage.goto(`${DEMO_ORIGIN}/basic.html`);
  const tab = await findDemoTab(page, 'basic.html');
  const { snapshot } = await runFill(page, tab.tabId, restored.activeProfileVersionId!);
  expect(snapshot.summary['filled']).toBeGreaterThan(5);
  await expect(demoPage.locator('#fullname')).toHaveValue('林示例');

  await fresh.context.close();
});

test('无效导入不会破坏已有数据', async () => {
  const fixture = await launchExtension(mkdtempSync(path.join(tmpdir(), 'applykit-e2e-invalid-')));
  const page = await fixture.context.newPage();
  await page.goto(appUrl(fixture.extensionId));
  await importDemoProfile(page);
  const before = await getState(page);

  for (const name of [
    'profile.wrong-kind.json',
    'profile.bad-date.json',
    'profile.day-without-month.json',
    'profile.future-version.json',
    'profile.bad-url.json',
  ]) {
    await page.reload();
    await page.locator('#profile-file').setInputFiles(path.join(ROOT, 'fixtures/invalid', name));
    await page.getByRole('button', { name: '校验并导入' }).click();
    await expect(page.locator('.preview .error').first()).toBeVisible();
    const after = await getState(page);
    expect(after.profiles).toHaveLength(before.profiles.length);
    expect(after.activeProfileVersionId).toBe(before.activeProfileVersionId);
  }

  await fixture.context.close();
});

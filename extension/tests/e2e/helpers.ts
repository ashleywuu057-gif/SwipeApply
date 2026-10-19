import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';

/** 端到端测试基础设施：以真实扩展方式加载 .test-dist/，使用独立临时浏览器目录。 */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TEST_DIST = path.join(ROOT, '.test-dist');
export const DEMO_ORIGIN = 'http://127.0.0.1:4173';
export const PROFILE_FIXTURE = path.join(ROOT, 'fixtures/profile.demo.json');

export interface ExtensionFixture {
  context: BrowserContext;
  extensionId: string;
  worker: Worker;
}

export async function launchExtension(userDataDir: string): Promise<ExtensionFixture> {
  if (!existsSync(TEST_DIST)) {
    throw new Error('缺少 .test-dist/，请先运行 npm run build:e2e');
  }
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${TEST_DIST}`,
      `--load-extension=${TEST_DIST}`,
      '--no-first-run',
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  return { context, extensionId, worker };
}

export function appUrl(extensionId: string, hash = 'profiles'): string {
  return `chrome-extension://${extensionId}/app.html#${hash}`;
}

export interface Reply<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** 从扩展工作台页面调用生产消息链路，与界面按钮走同一套处理器。 */
export async function callBackground<T>(page: Page, type: string, payload: unknown = {}): Promise<T> {
  const reply = await page.evaluate(
    async ([messageType, messagePayload]) => {
      const response = await chrome.runtime.sendMessage({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        type: messageType,
        payload: messagePayload,
      });
      return response as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
    },
    [type, payload] as [string, unknown],
  );
  if (!reply.ok) {
    throw new Error(`${type} 失败：${reply.error?.code} ${reply.error?.message}`);
  }
  return reply.data as T;
}

export interface StateView {
  revision: number;
  activeProfileVersionId: string | null;
  profiles: Array<{ profileVersionId: string; name: string }>;
  applications: Array<Record<string, unknown>>;
  mappings: Array<Record<string, unknown>>;
  recentRuns: Array<Record<string, unknown>>;
}

export function getState(page: Page): Promise<StateView> {
  return callBackground<StateView>(page, 'GET_STATE');
}

/** 通过工作台界面导入虚构履历（走真实的文件校验与预览流程）。 */
export async function importDemoProfile(page: Page): Promise<void> {
  await page.goto(page.url().split('#')[0] + '#profiles');
  await page.locator('#profile-file').setInputFiles(PROFILE_FIXTURE);
  await page.getByRole('button', { name: '校验并导入' }).click();
  await page.locator('#btn-confirm-import').click();
  await expect.poll(async () => (await getState(page)).activeProfileVersionId).not.toBeNull();
}

export interface TargetTab {
  tabId: number;
  url: string;
  title: string;
}

export async function findDemoTab(page: Page, urlPart: string): Promise<TargetTab> {
  const tabs = await callBackground<TargetTab[]>(page, 'LIST_TARGET_TABS');
  const tab = tabs.find((entry) => entry.url.includes(urlPart));
  if (!tab) throw new Error(`没有找到演示标签页 ${urlPart}，实际可见：${tabs.map((t) => t.url).join(', ')}`);
  return tab;
}

export interface PrepareRunOutput {
  runId: string;
  phase: string;
  planned: number;
  pending: number;
  reused: boolean;
  notes: string[];
  scan: {
    fieldCount: number;
    adapterId?: string | null;
    jobCandidate: { company: string | null; role: string | null; externalJobId: string | null } | null;
  };
}

export interface RunSnapshot {
  report: {
    id: string;
    phase: string;
    modelCalls: number;
    finishedAt: string | null;
    fields: Array<{ fieldId: string; label: string; outcome: string; reasonCode: string }>;
  };
  summary: Record<string, number>;
  descriptors: Array<{ fieldId: string; label: string; controlKind: string; datePrecision: 'year' | 'month' | 'day' | null; unsupportedReason: string | null; recordInstanceId: string | null }>;
}

export async function runFill(
  appPage: Page,
  tabId: number,
  profileVersionId: string,
  mode: 'scan' | 'fill' = 'fill',
): Promise<{ run: PrepareRunOutput; snapshot: RunSnapshot }> {
  const run = await callBackground<PrepareRunOutput>(appPage, 'PREPARE_RUN', {
    targetTabId: tabId,
    profileVersionId,
    mode,
    applicationId: null,
  });
  const snapshot = await waitForRun(appPage, run.runId);
  return { run, snapshot };
}

export async function waitForRun(page: Page, runId: string, timeout = 60_000): Promise<RunSnapshot> {
  const deadline = Date.now() + timeout;
  let snapshot = await callBackground<RunSnapshot>(page, 'GET_RUN', { runId });
  while (!snapshot.report.finishedAt && Date.now() < deadline) {
    await page.waitForTimeout(150);
    snapshot = await callBackground<RunSnapshot>(page, 'GET_RUN', { runId });
  }
  return snapshot;
}

/** 页面自己的事件状态：用于识别「只改视觉值」的假成功。 */
export function demoReceived(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => (window as unknown as { __demoReceived: () => Record<string, string> }).__demoReceived());
}

export function outcomeOf(snapshot: RunSnapshot, label: string): { outcome: string; reasonCode: string } {
  const field = snapshot.report.fields.find((entry) => entry.label === label);
  if (!field) {
    throw new Error(`报告中没有字段「${label}」，实际有：${snapshot.report.fields.map((f) => f.label).join(' / ')}`);
  }
  return { outcome: field.outcome, reasonCode: field.reasonCode };
}

export function fieldIdOf(snapshot: RunSnapshot, label: string): string {
  const field = snapshot.report.fields.find((entry) => entry.label === label);
  if (!field) throw new Error(`报告中没有字段「${label}」`);
  return field.fieldId;
}

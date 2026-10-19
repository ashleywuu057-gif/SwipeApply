import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  appUrl, callBackground, DEMO_ORIGIN, demoReceived, fieldIdOf, findDemoTab, getState,
  importDemoProfile, launchExtension, outcomeOf, runFill,
} from './helpers';

/** E03 / E04 / E08：陌生标签的学习、规则失效、地址不混填、日期精度与禁止操作的控件。 */

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let appPage: Page;
let demoPage: Page;
let profileVersionId: string;

test.beforeAll(async () => {
  const fixture = await launchExtension(mkdtempSync(path.join(tmpdir(), 'applykit-e2e-edge-')));
  context = fixture.context;
  appPage = await context.newPage();
  await appPage.goto(appUrl(fixture.extensionId));
  await importDemoProfile(appPage);
  profileVersionId = (await getState(appPage)).activeProfileVersionId!;
  demoPage = await context.newPage();
  await demoPage.goto(`${DEMO_ORIGIN}/edge-cases.html`);
});

test.afterAll(async () => {
  await context?.close();
});

test('E08 地址不混填、教育日期按约定补全、声明与附件保持待处理', async () => {
  const tab = await findDemoTab(appPage, 'edge-cases.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  // 三种地址各自独立，只有「现居地」有对应字段。
  await expect(demoPage.locator('#current-address')).toHaveValue('杭州');
  await expect(demoPage.locator('#registered-address')).toHaveValue('');
  await expect(demoPage.locator('#edu-address')).toHaveValue('');
  expect(outcomeOf(snapshot, '户籍地').reasonCode).toBe('NO_MATCH');
  expect(outcomeOf(snapshot, '学校地址').reasonCode).toBe('NO_MATCH');

  // 教育毕业日期只有年月时，按用户约定补为 6 月 30 日。
  expect(outcomeOf(snapshot, '毕业时间')).toEqual({ outcome: 'filled', reasonCode: 'FILLED_VERIFIED' });
  await expect(demoPage.locator('#edu-graduation')).toHaveValue('2027-06-30');

  // 声明、附件、iframe 与无语义控件都不被操作。
  for (const label of ['我声明以上信息真实有效', '简历附件', '内嵌问卷', '自定义评分控件']) {
    expect(outcomeOf(snapshot, label)).toEqual({ outcome: 'pending', reasonCode: 'UNSUPPORTED_WIDGET' });
  }
  await expect(demoPage.locator('#declaration')).not.toBeChecked();

  // 待处理项给出具体原因，而不是只有技术错误码。
  const reasons = new Map(snapshot.descriptors.map((item) => [item.label, item.unsupportedReason]));
  expect(reasons.get('简历附件')).toContain('附件需要你自己上传');
  expect(reasons.get('我声明以上信息真实有效')).toContain('声明与授权类勾选需要你自己确认');
  expect(reasons.get('内嵌问卷')).toContain('内嵌页面');
  expect(reasons.get('自定义评分控件')).toContain('自定义的控件');

  // 密码与隐藏字段不出现在报告中，也没有被读取或改写。
  expect(snapshot.report.fields.some((field) => field.label.includes('密码'))).toBe(false);
  await expect(demoPage.locator('#password')).toHaveValue('');
  await expect(demoPage.locator('#csrf')).toHaveValue('demo-hidden-value');

  // 两个同名项目：只有能唯一确认的那一条被填写，另一条保持待处理。
  const roleFields = snapshot.report.fields.filter((field) => field.label === '项目职责');
  expect(roleFields.filter((field) => field.outcome === 'filled')).toHaveLength(1);
  expect(roleFields.filter((field) => field.reasonCode === 'AMBIGUOUS_RECORD')).toHaveLength(1);
  await expect(demoPage.locator('#proj-a-role')).toHaveValue('独立开发');
  await expect(demoPage.locator('#proj-b-role')).toHaveValue('');
  await expect(demoPage.locator('#proj-b-name')).toHaveValue('示例知识检索助手');

  // 学历层级按页面标注绑定到硕士经历。
  await expect(demoPage.locator('#degree-level')).toHaveValue('硕士');
});

test('E03 陌生标签首次待处理，手动对应并记住后可自动填写', async () => {
  await demoPage.reload();
  const tab = await findDemoTab(appPage, 'edge-cases.html');
  const first = await runFill(appPage, tab.tabId, profileVersionId);

  expect(outcomeOf(first.snapshot, '联系信箱入口')).toEqual({ outcome: 'pending', reasonCode: 'NO_MATCH' });
  await expect(demoPage.locator('#contact-inbox')).toHaveValue('');

  // 用户在结果页把这个字段对应到「邮箱」，并勾选记住。
  const fieldId = fieldIdOf(first.snapshot, '联系信箱入口');
  const retry = await callBackground<{ verified: boolean; mappingSaved: boolean }>(appPage, 'RETRY_FIELD', {
    runId: first.run.runId,
    fieldId,
    source: { section: 'personal', field: 'email' },
    remember: true,
    overwriteExisting: false,
  });
  expect(retry.verified).toBe(true);
  expect(retry.mappingSaved).toBe(true);
  await expect(demoPage.locator('#contact-inbox')).toHaveValue('lin@example.com');
  expect((await demoReceived(demoPage))['contact-inbox']).toBe('lin@example.com');

  const state = await getState(appPage);
  expect(state.mappings).toHaveLength(1);
  // 规则里不保存任何具体内容。
  expect(JSON.stringify(state.mappings)).not.toContain('lin@example.com');

  // 清空演示页后再次填写：同样结构的字段自动命中规则。
  await demoPage.locator('#demo-reset').click();
  await expect(demoPage.locator('#contact-inbox')).toHaveValue('');
  const second = await runFill(appPage, tab.tabId, profileVersionId);
  expect(outcomeOf(second.snapshot, '联系信箱入口')).toEqual({ outcome: 'filled', reasonCode: 'FILLED_VERIFIED' });
  await expect(demoPage.locator('#contact-inbox')).toHaveValue('lin@example.com');
});

test('E04 页面结构变化后旧规则失效，不会误填', async () => {
  await demoPage.reload();
  await demoPage.locator('#demo-switch-layout').click();
  await expect(demoPage.locator('#layout-state')).toHaveText('当前布局：新版');

  const tab = await findDemoTab(appPage, 'edge-cases.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  // 标签变化后规则不再命中，字段回到待处理而不是填错。
  expect(outcomeOf(snapshot, '联系信箱入口（新版）').outcome).toBe('pending');
  await expect(demoPage.locator('#contact-inbox')).toHaveValue('');

  // 选项集合变化后，枚举不再有唯一等价项。
  expect(outcomeOf(snapshot, '学历')).toEqual({ outcome: 'pending', reasonCode: 'AMBIGUOUS_OPTION' });
  await expect(demoPage.locator('#degree-level')).toHaveValue('');

  // 规则仍然保存着，可以在规则页查看与删除。
  const state = await getState(appPage);
  expect(state.mappings).toHaveLength(1);
  await appPage.goto(appUrl((await getExtensionId(appPage)), 'rules'));
  await expect(appPage.locator('#rule-list .record')).toHaveCount(1);
  await appPage.getByRole('button', { name: '删除规则' }).click();
  await expect.poll(async () => (await getState(appPage)).mappings.length).toBe(0);
});

async function getExtensionId(page: Page): Promise<string> {
  return new URL(page.url()).host;
}

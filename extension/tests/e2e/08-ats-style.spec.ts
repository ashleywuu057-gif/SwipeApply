import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  appUrl, callBackground, DEMO_ORIGIN, demoReceived, findDemoTab, getState, importDemoProfile,
  launchExtension, outcomeOf, runFill,
} from './helpers';
import type { ProfileFile } from '../../src/shared/types';

/**
 * 国内常见 ATS 的 DOM 形态回归（对照 app.mokahr.com 2026-09-04 实测结构）：
 * 分区标题与字段标签都是带随机后缀类名的 div，没有 label[for]；
 * 一部分「输入框」是自定义下拉的壳；账号带来的字段被网站锁定。
 */

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let appPage: Page;
let demoPage: Page;
let profileVersionId: string;

test.beforeAll(async () => {
  const fixture = await launchExtension(mkdtempSync(path.join(tmpdir(), 'applykit-e2e-ats-')));
  context = fixture.context;
  appPage = await context.newPage();
  await appPage.goto(appUrl(fixture.extensionId));
  await importDemoProfile(appPage);
  profileVersionId = (await getState(appPage)).activeProfileVersionId!;
  demoPage = await context.newPage();
  await demoPage.goto(`${DEMO_ORIGIN}/ats-style.html`);
});

test.afterAll(async () => {
  await context?.close();
});

test('div 标签 + div 分区标题的表单能被正确识别与填写', async () => {
  const tab = await findDemoTab(appPage, 'ats-style.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  // 标签在控件祖先的兄弟节点上，仍然要能解析出来。
  for (const label of ['邮箱', '所在地', '工作职责', '语言类型', '自我描述']) {
    expect(outcomeOf(snapshot, label).outcome, `${label} 应被填写`).toBe('filled');
  }

  await expect(demoPage.locator('[name="email"]')).toHaveValue('lin@example.com');
  await expect(demoPage.locator('[name="city"]')).toHaveValue('杭州');
  await expect(demoPage.locator('[name="intern-company"]')).toHaveValue('云笺科技（虚构）');
  await expect(demoPage.locator('[name="intern-title"]')).toHaveValue('后端开发实习生');
  await expect(demoPage.locator('[name="lang-type"]')).toHaveValue('英语');

  // 页面自己的事件状态同步更新，证明不是只改了视觉值。
  const received = await demoReceived(demoPage);
  expect(received['email']).toBe('lin@example.com');
  expect(received['intern-company']).toBe('云笺科技（虚构）');
  expect(received['self-desc']).toContain('AI 应用');
});

test('工作经历与实习经历分开：两类记录不串位', async () => {
  const tab = await findDemoTab(appPage, 'ats-style.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  // 履历模型里只有实习经历一类，页面上两块都叫「公司名称」。
  await expect(demoPage.locator('[name="intern-company"]')).toHaveValue('云笺科技（虚构）');
  await expect(demoPage.locator('[name="intern-title"]')).toHaveValue('后端开发实习生');
  await expect(demoPage.locator('[name="work-company"]')).toHaveValue('星河网络（虚构）');
  await expect(demoPage.locator('[name="work-title"]')).toHaveValue('Python 开发工程师');

  // 本文件是串行套件，这里可能是重复运行，已填字段的结果是 unchanged。
  const companies = snapshot.report.fields.filter((field) => field.label === '公司名称');
  expect(companies.filter((field) => field.outcome === 'filled' || field.outcome === 'unchanged')).toHaveLength(2);
  expect(companies.filter((field) => field.outcome === 'pending')).toHaveLength(0);
});

test('没有 ARIA 的自定义下拉：点开、精确匹配、点击、回读确认', async () => {
  const tab = await findDemoTab(appPage, 'ats-style.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  // 串行套件里可能是重复运行，已选中的结果是 unchanged。
  const bound = (label: string) => expect(['filled', 'unchanged'], label).toContain(outcomeOf(snapshot, label).outcome);

  // 普通下拉：选项点开后才渲染。
  bound('语言类型');
  await expect(demoPage.locator('[name="lang-type"]')).toHaveValue('英语');

  // 最高学历由教育记录确定，不要求履历重复保存一份汇总字段。
  bound('最高学历');
  await expect(demoPage.locator('[name="degree"]')).toHaveValue('硕士');

  // 布尔值经等价词表落到「否」这个选项上。
  bound('是否接受异地');
  await expect(demoPage.locator('[name="relocation"]')).toHaveValue('否');

  // 可搜索下拉：先输入关键字过滤，再点选项。
  bound('实习城市');
  await expect(demoPage.locator('[name="intern-city"]')).toHaveValue('杭州');

  // 关键：值必须是页面自己在点击选项后写回的，不是扩展直接塞进输入框的。
  const received = await demoReceived(demoPage);
  expect(received['lang-type']).toBe('英语');
  expect(received['relocation']).toBe('否');
  expect(received['intern-city']).toBe('杭州');
});

test('四段式年月范围按顺序识别开始/结束，并通过下拉真实点选', async () => {
  const tab = await findDemoTab(appPage, 'ats-style.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);
  const bound = (label: string) => expect(['filled', 'unchanged'], label).toContain(outcomeOf(snapshot, label).outcome);

  for (const label of ['开始时间（年）', '开始时间（月）', '结束时间（年）', '结束时间（月）']) bound(label);
  await expect(demoPage.locator('[name="intern-start-year"]')).toHaveValue('2026');
  await expect(demoPage.locator('[name="intern-start-month"]')).toHaveValue('2');
  await expect(demoPage.locator('[name="intern-end-year"]')).toHaveValue('2026');
  await expect(demoPage.locator('[name="intern-end-month"]')).toHaveValue('7');

  const received = await demoReceived(demoPage);
  expect(received['intern-start-year']).toBe('2026');
  expect(received['intern-start-month']).toBe('2');
  expect(received['intern-end-year']).toBe('2026');
  expect(received['intern-end-month']).toBe('7');
});

test('下拉里没有对应选项时原样退出，不留下过滤文字', async () => {
  // 履历是「男」，但这个仿真下拉故意只提供「女 / 不愿透露」。
  const tab = await findDemoTab(appPage, 'ats-style.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  expect(outcomeOf(snapshot, '性别')).toEqual({ outcome: 'pending', reasonCode: 'AMBIGUOUS_OPTION' });
  await expect(demoPage.locator('[name="gender"]')).toHaveValue('');
  expect((await demoReceived(demoPage))['gender']).toBe('');
});

test('自定义日期选择器仍然不被操作', async () => {
  const tab = await findDemoTab(appPage, 'ats-style.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  const birth = outcomeOf(snapshot, '出生日期');
  expect(birth.outcome).toBe('pending');
  expect(birth.reasonCode).toBe('UNSUPPORTED_WIDGET');
  await expect(demoPage.locator('[name="birth"]')).toHaveValue('');

  const reasons = new Map(snapshot.descriptors.map((item) => [item.label, item.unsupportedReason]));
  expect(reasons.get('出生日期')).toContain('日期选择器');
});

test('网站锁定的账号字段不被改动，并说明原因', async () => {
  const tab = await findDemoTab(appPage, 'ats-style.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  for (const label of ['姓名', '手机号码']) {
    expect(outcomeOf(snapshot, label)).toEqual({ outcome: 'pending', reasonCode: 'REQUIRES_USER_ACTION' });
  }
  // 网站自己的原值保持不变。
  await expect(demoPage.locator('[name="acct-name"]')).toHaveValue('账号带来的姓名');
  await expect(demoPage.locator('[name="acct-phone"]')).toHaveValue('00000000001');

  const reasons = new Map(snapshot.descriptors.map((item) => [item.label, item.unsupportedReason]));
  expect(reasons.get('姓名')).toContain('网站锁定');
});

test('通用适配器不会使用履历中的证件号码等敏感字段', async () => {
  const tab = await findDemoTab(appPage, 'ats-style.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  expect(outcomeOf(snapshot, '证件号码')).toEqual({ outcome: 'pending', reasonCode: 'REQUIRES_USER_ACTION' });
  await expect(demoPage.locator('[name="id-number"]')).toHaveValue('');

  const reasons = new Map(snapshot.descriptors.map((item) => [item.label, item.unsupportedReason]));
  expect(reasons.get('证件号码')).toContain('敏感信息');
});

test('一个网页经历位置对应多条履历经历时保持待处理，不猜', async () => {
  // 本用例专门验证「没有默认标记」时仍不猜；前面的用例使用默认教育记录。
  const backup = await callBackground<{ state: { profiles: ProfileFile[] } }>(appPage, 'EXPORT_BACKUP');
  const current = backup.state.profiles.find((profile) => profile.profileVersionId === profileVersionId)!;
  const data = structuredClone(current.data);
  data.education = data.education.map((record) => ({ ...record, primary: false }));
  const state = await getState(appPage);
  const saved = await callBackground<{ profileVersionId: string }>(appPage, 'SAVE_PROFILE', {
    profileId: current.profileId,
    name: `${current.name}（无默认记录测试）`,
    data,
    expectedRevision: state.revision,
  });
  profileVersionId = saved.profileVersionId;
  await demoPage.locator('#demo-reset').click();
  const tab = await findDemoTab(appPage, 'ats-style.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  // 页面只有一段教育位置，履历里有硕士与本科两段：无法证明对应关系。
  for (const label of ['学校名称', '专业']) {
    expect(outcomeOf(snapshot, label)).toEqual({ outcome: 'pending', reasonCode: 'AMBIGUOUS_RECORD' });
  }
  await expect(demoPage.locator('[name="edu-school"]')).toHaveValue('');
});

test('经历归属有歧义时，用户指定一次就整组填写', async () => {
  await demoPage.locator('#demo-reset').click();
  const tab = await findDemoTab(appPage, 'ats-style.html');
  const { run, snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  // 页面只有一段教育位置，履历里有硕士与本科两段 → 整组待处理。
  const ambiguous = snapshot.report.fields.filter((field) => field.reasonCode === 'AMBIGUOUS_RECORD');
  expect(ambiguous.length).toBeGreaterThanOrEqual(2);
  await expect(demoPage.locator('[name="edu-school"]')).toHaveValue('');

  const instanceId = snapshot.descriptors.find((item) => item.label === '专业')?.recordInstanceId;
  expect(instanceId).toBeTruthy();

  // 用户指定这一组对应「硕士」那条经历。
  const result = await callBackground<{ filled: number; pending: number }>(appPage, 'BIND_RECORD', {
    runId: run.runId,
    recordInstanceId: instanceId,
    recordId: 'edu-demo-master',
    remember: false,
  });
  expect(result.filled).toBeGreaterThanOrEqual(2);

  // 整组一次填好，值来自指定的那条经历，不是另一条。
  await expect(demoPage.locator('[name="edu-school"]')).toHaveValue('示例理工大学');
  await expect(demoPage.locator('[name="edu-major"]')).toHaveValue('软件工程');
  const received = await demoReceived(demoPage);
  expect(received['edu-school']).toBe('示例理工大学');
  expect(received['edu-major']).toBe('软件工程');
});

test('指定不存在的经历会被拒绝', async () => {
  const tab = await findDemoTab(appPage, 'ats-style.html');
  const { run, snapshot } = await runFill(appPage, tab.tabId, profileVersionId);
  const instanceId = snapshot.descriptors.find((item) => item.recordInstanceId !== null)?.recordInstanceId;
  await expect(
    callBackground(appPage, 'BIND_RECORD', {
      runId: run.runId, recordInstanceId: instanceId, recordId: 'not-a-real-record', remember: false,
    }),
  ).rejects.toThrow(/找不到这条经历/);
});

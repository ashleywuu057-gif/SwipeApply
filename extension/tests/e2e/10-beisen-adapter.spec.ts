import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  appUrl, DEMO_ORIGIN, findDemoTab, getState, importDemoProfile, launchExtension, runFill,
} from './helpers';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let appPage: Page;
let beisenPage: Page;
let profileVersionId: string;

test.beforeAll(async () => {
  const fixture = await launchExtension(mkdtempSync(path.join(tmpdir(), 'applykit-e2e-beisen-')));
  context = fixture.context;
  appPage = await context.newPage();
  await appPage.goto(appUrl(fixture.extensionId));
  await importDemoProfile(appPage);
  profileVersionId = (await getState(appPage)).activeProfileVersionId!;
  beisenPage = await context.newPage();
  await beisenPage.goto(`${DEMO_ORIGIN}/beisen-style.html`);
});

test.afterAll(async () => {
  await context?.close();
});

test('北森扫描只保留真实表单，并识别稳定标签、分区和 Phoenix 控件', async () => {
  const tab = await findDemoTab(appPage, 'beisen-style.html');
  const { run, snapshot } = await runFill(appPage, tab.tabId, profileVersionId, 'scan');

  expect(run.scan.adapterId).toBe('beisen-zhiye-phoenix');
  expect(run.scan.fieldCount).toBe(50);
  expect(snapshot.report.fields.some((field) => field.label === '请选择')).toBe(false);
  expect(snapshot.report.fields.some((field) => field.label === '房间')).toBe(false);
  expect(snapshot.report.fields.some((field) => field.label === '密码')).toBe(false);

  const byLabel = (label: string) => snapshot.descriptors.filter((field) => field.label === label);
  expect(byLabel('性别')).toEqual([expect.objectContaining({ controlKind: 'radio' })]);
  expect(byLabel('学历')).toEqual([expect.objectContaining({ controlKind: 'combobox', recordInstanceId: expect.any(String) })]);
  expect(byLabel('学校名称')).toEqual([expect.objectContaining({ controlKind: 'combobox', recordInstanceId: expect.any(String) })]);
  expect(byLabel('出生日期')).toEqual([expect.objectContaining({ controlKind: 'date-picker' })]);
  expect(byLabel('现居住地')).toEqual([expect.objectContaining({ controlKind: 'combobox' })]);
  expect(byLabel('籍贯')).toEqual([expect.objectContaining({ controlKind: 'combobox' })]);
  expect(byLabel('生源地')).toEqual([expect.objectContaining({ controlKind: 'combobox' })]);
  expect(byLabel('期望工作城市')).toEqual([expect.objectContaining({ controlKind: 'combobox' })]);
  expect(byLabel('到岗时间')).toEqual([expect.objectContaining({ controlKind: 'combobox' })]);
  expect(byLabel('毕业时间')).toEqual([expect.objectContaining({ controlKind: 'date-picker', datePrecision: 'day' })]);
  expect(byLabel('发布时间')).toEqual([expect.objectContaining({ controlKind: 'date-picker', datePrecision: 'day' })]);
});

test('北森适配器通过页面控件填写、增加经历并在第二轮稳定回读', async () => {
  const tab = await findDemoTab(appPage, 'beisen-style.html');
  const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);

  expect(snapshot.report.phase).toBe('completed');
  expect(snapshot.report.fields.filter((field) => field.outcome === 'failed')).toHaveLength(0);
  expect(snapshot.report.fields.filter((field) => ['实验室', '研究方向', '导师'].includes(field.label)))
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '实验室', outcome: 'filled' }),
      expect.objectContaining({ label: '研究方向', outcome: 'filled' }),
      expect.objectContaining({ label: '导师', outcome: 'filled' }),
    ]));
  expect(snapshot.report.fields.filter((field) => field.label === '至今').every((field) => field.outcome !== 'pending'))
    .toBe(true);
  await expect(beisenPage.locator('[name="full-name"]')).toHaveValue('林示例');
  await expect(beisenPage.locator('[name="preferred-city"]')).toHaveAttribute('data-selected-value', '杭州市');
  await expect(beisenPage.locator('[name="current-city"]')).toHaveAttribute('data-selected-value', '杭州市');
  await expect(beisenPage.locator('[name="native-place"]')).toHaveAttribute('data-selected-value', '苏州市');
  await expect(beisenPage.locator('[name="student-origin"]')).toHaveAttribute('data-selected-value', '苏州市');
  await expect(beisenPage.locator('[name="highest-education-type"]')).toHaveAttribute('data-selected-value', '全国普通高等院校全日制');
  await expect(beisenPage.locator('[name="highest-graduation-date"]')).toHaveAttribute('data-selected-value', '2027年6月30日');
  expect(snapshot.report.fields.find((field) => field.label === '毕业时间')).toEqual(
    expect.objectContaining({ outcome: 'filled', reasonCode: 'FILLED_VERIFIED' }),
  );
  await expect(beisenPage.locator('[name="identity-number"]')).toHaveValue('320000200001010000');
  await expect(beisenPage.locator('[name="emergency-contact"]')).toHaveValue('林家长（虚构）');
  await expect(beisenPage.locator('[name="emergency-phone"]')).toHaveValue('00000000001');
  await expect(beisenPage.locator('[name="english-level"]')).toHaveAttribute('data-selected-value', '大学英语四级');
  await expect(beisenPage.locator('[name="english-score"]')).toHaveValue('500');
  await expect(beisenPage.locator('[name="expected-city"]')).toHaveAttribute(
    'data-selected-values', JSON.stringify(['杭州市', '上海市']),
  );
  await expect(beisenPage.locator('[name="availability"]')).toHaveAttribute('data-selected-value', '一周内');
  await expect(beisenPage.locator('[data-name="gender"] .phoenix-radio--checked')).toHaveText('男');
  await expect(beisenPage.locator('[data-name="relocation"] .phoenix-radio--checked')).toHaveText('否');
  await expect(beisenPage.locator('[name="birth-date"]')).toHaveAttribute('data-selected-value', '2002年4月15日');

  await expect(beisenPage.locator('[data-repeated="education"] [data-record]')).toHaveCount(2);
  await expect(beisenPage.locator('[name="education-degree-1"]')).toHaveAttribute('data-selected-value', '硕士研究生');
  await expect(beisenPage.locator('[name="education-school-1"]')).toHaveAttribute('data-selected-value', '示例理工大学');
  await expect(beisenPage.locator('[name="education-start-1"]')).toHaveAttribute('data-selected-value', '2024年9月');
  await expect(beisenPage.locator('[name="education-lab-1"]')).toHaveValue('示例网络空间安全实验室');
  await expect(beisenPage.locator('[name="education-student-number-1"]')).toHaveValue('202409000001');
  await expect(beisenPage.locator('[name="education-topic-1"]')).toHaveValue('智能体系统与软件安全');
  await expect(beisenPage.locator('[name="education-research-1"]')).toHaveValue('智能体系统与软件安全');
  await expect(beisenPage.locator('[name="education-gpa-1"]')).toHaveValue('3.60');
  await expect(beisenPage.locator('[name="education-advisor-1"]')).toHaveValue('示例导师');
  await expect(beisenPage.locator('[name="education-degree-2"]')).toHaveAttribute('data-selected-value', '本科');
  await expect(beisenPage.locator('[name="education-school-2"]')).toHaveAttribute('data-selected-value', '示例工程学院');
  await expect(beisenPage.locator('[data-name="education-highest-1"] .phoenix-radio--checked')).toHaveText('是');
  await expect(beisenPage.locator('[data-name="education-highest-2"] .phoenix-radio--checked')).toHaveText('否');

  await expect(beisenPage.locator('[name="internship-company-1"]')).toHaveValue('云笺科技（虚构）');
  await expect(beisenPage.locator('[data-repeated="projects"] [data-record]')).toHaveCount(2);
  await expect(beisenPage.locator('[name="project-name-1"]')).toHaveValue('示例知识检索助手');
  await expect(beisenPage.locator('[name="project-role-1"]')).toHaveValue('独立开发');
  await expect(beisenPage.locator('[name="project-result-1"]')).toHaveValue('使用 Python 实现一个虚构的文档检索演示，包含导入、查询和结果展示。');
  await expect(beisenPage.locator('[name="project-present-1"]')).toBeChecked();
  await expect(beisenPage.locator('[name="award-name-1"]')).toHaveValue('示例创新实践奖（虚构）');
  await expect(beisenPage.locator('[name="award-date-1"]')).toHaveAttribute('data-selected-value', '2025年11月1日');
  await expect(beisenPage.locator('[name="publication-name-1"]')).toHaveValue('示例智能检索框架研究（虚构）');
  await expect(beisenPage.locator('[name="publication-date-1"]')).toHaveAttribute('data-selected-value', '2025年9月20日');
  await expect(beisenPage.locator('[name="certificate-name-1"]')).toHaveValue('示例软件能力证书（虚构）');
  await expect(beisenPage.locator('[name="certificate-description-1"]')).toHaveValue('仅用于验证证书名称和描述；获得时间有意留空。');

  const received = await beisenPage.evaluate(() =>
    (window as unknown as { __beisenReceived: () => Record<string, string> }).__beisenReceived());
  expect(received['birth-date']).toBe('2002年4月15日');
  expect(received['preferred-city']).toBe('杭州市');
  expect(received['current-city']).toBe('杭州市');
  expect(received['native-place']).toBe('苏州市');
  expect(received['student-origin']).toBe('苏州市');
  expect(received['highest-education-type']).toBe('全国普通高等院校全日制');
  expect(received['english-level']).toBe('大学英语四级');
  expect(received['expected-city']).toBe(JSON.stringify(['杭州市', '上海市']));
  expect(received['availability']).toBe('一周内');
  expect(received['education-student-number-1']).toBe('202409000001');
  expect(received['education-start-1']).toBe('2024年9月');
  expect(received['gender']).toBe('男');

  const second = await runFill(appPage, tab.tabId, profileVersionId);
  expect(second.snapshot.report.fields.filter((field) => field.outcome === 'failed')).toHaveLength(0);
  expect(second.snapshot.report.fields.some((field) => field.label === '请选择')).toBe(false);
  await expect(beisenPage.locator('[data-repeated="education"] [data-record]')).toHaveCount(2);
});

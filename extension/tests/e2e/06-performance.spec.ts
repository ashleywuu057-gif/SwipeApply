import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import {
  appUrl, DEMO_ORIGIN, findDemoTab, getState, importDemoProfile, launchExtension, ROOT, runFill,
} from './helpers';

/** 定量门槛：每页跑 5 次，记录中位数与最大值。数字来自真实执行，不预填。 */

const RUNS = 5;

interface PageResult {
  page: string;
  fields: number;
  filled: number;
  durations: number[];
  median: number;
  max: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!;
}

test('性能：三个演示页面各跑 5 次并记录耗时', async () => {
  test.setTimeout(180_000);
  const fixture = await launchExtension(mkdtempSync(path.join(tmpdir(), 'applykit-e2e-perf-')));
  const appPage = await fixture.context.newPage();
  await appPage.goto(appUrl(fixture.extensionId));
  await importDemoProfile(appPage);
  const profileVersionId = (await getState(appPage)).activeProfileVersionId!;

  const demoPage = await fixture.context.newPage();
  const results: PageResult[] = [];

  for (const page of ['basic.html', 'experience.html', 'edge-cases.html']) {
    const durations: number[] = [];
    let fields = 0;
    let filled = 0;
    for (let i = 0; i < RUNS; i += 1) {
      await demoPage.goto(`${DEMO_ORIGIN}/${page}`);
      const tab = await findDemoTab(appPage, page);
      const started = Date.now();
      const { snapshot } = await runFill(appPage, tab.tabId, profileVersionId);
      durations.push(Date.now() - started);
      fields = snapshot.report.fields.length;
      filled = snapshot.summary['filled'] ?? 0;
    }
    results.push({ page, fields, filled, durations, median: median(durations), max: Math.max(...durations) });
  }

  const version = await appPage.evaluate(() => navigator.userAgent);
  const report = {
    measuredAt: new Date().toISOString(),
    browser: version,
    platform: process.platform,
    note: '耗时包含扫描、匹配、DOM 操作与回读，不包含用户手动处理与提交。',
    results,
  };
  mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  writeFileSync(path.join(ROOT, 'test-results/performance.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));

  for (const result of results) {
    // basic / edge-cases 为普通字段页；experience 含异步下拉与新增经历。
    const budget = result.page === 'experience.html' ? 15_000 : 5_000;
    expect(result.median, `${result.page} 中位数`).toBeLessThan(budget);
  }
  await fixture.context.close();
  expect(chromium.name()).toBe('chromium');
});

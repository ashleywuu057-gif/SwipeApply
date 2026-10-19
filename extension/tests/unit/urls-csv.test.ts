import { describe, expect, it } from 'vitest';
import {
  buildCanonicalUrl, buildRouteKey, computeDedupeKey, dedupeConfidence, extractJobId,
  isInjectablePage, sanitizeUrl,
} from '../../src/shared/urls';
import { CSV_COLUMNS, parseCsvRows, parseCsvTable, protectFormula, toCsv, unprotectFormula, type CsvRow } from '../../src/shared/csv';
import { csvRowsToRecords, exportCsv, recordToCsvRow } from '../../src/background/applications';
import type { ApplicationRecord } from '../../src/shared/types';

describe('U07 URL 清洗与去重', () => {
  it('去掉令牌类查询参数与 userinfo', () => {
    const cleaned = sanitizeUrl('https://user:pw@jobs.example.com/apply?jobId=A12&token=secret&session=abc&utm_source=x');
    expect(cleaned).toBe('https://jobs.example.com/apply?jobId=A12&utm_source=x');
    expect(cleaned).not.toContain('secret');
    expect(cleaned).not.toContain('user:pw');
  });

  it('canonicalUrl 只保留已确认的岗位 ID 参数', () => {
    const canonical = buildCanonicalUrl('https://jobs.example.com/apply?jobId=A12&ref=weibo&t=1699');
    expect(canonical).toBe('https://jobs.example.com/apply?jobId=A12');
  });

  it('保留非默认端口与 hash 路由中的岗位路径', () => {
    expect(buildCanonicalUrl('http://127.0.0.1:4173/apply#/jobs/A12?x=1')).toBe('http://127.0.0.1:4173/apply#/jobs/A12');
    expect(buildRouteKey('http://127.0.0.1:4173/basic.html?jobId=1#/step-2')).toBe('/basic.html#/step-2');
  });

  it('不同 jobId 的岗位不会被合并', async () => {
    const a = await computeDedupeKey({
      company: '星帆科技', role: 'AI 应用开发', location: '杭州',
      canonicalUrl: 'https://jobs.example.com/apply?jobId=A12', externalJobId: 'A12',
    });
    const b = await computeDedupeKey({
      company: '星帆科技', role: 'Python 后端', location: '杭州',
      canonicalUrl: 'https://jobs.example.com/apply?jobId=B34', externalJobId: 'B34',
    });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('同一岗位的不同展示参数得到同一个 key', async () => {
    const a = await computeDedupeKey({
      company: '星帆科技（演示）', role: 'AI 应用开发实习生', location: '杭州',
      canonicalUrl: buildCanonicalUrl('https://jobs.example.com/apply?jobId=A12&ref=weibo'), externalJobId: 'A12',
    });
    const b = await computeDedupeKey({
      company: ' 星帆科技（演示） ', role: 'ai 应用开发实习生', location: '杭州',
      canonicalUrl: buildCanonicalUrl('https://jobs.example.com/apply?jobId=A12&t=999'), externalJobId: 'A12',
    });
    expect(a).toBe(b);
  });

  it('没有链接与岗位 ID 时提示身份信息不完整', () => {
    expect(dedupeConfidence({ company: 'A', role: 'B', location: null, canonicalUrl: null, externalJobId: null })).toBe('weak');
    expect(dedupeConfidence({ company: 'A', role: 'B', location: null, canonicalUrl: 'https://x.example/a', externalJobId: null })).toBe('strong');
  });

  it('识别不能填写的页面', () => {
    expect(isInjectablePage('https://jobs.example.com/apply').ok).toBe(true);
    expect(isInjectablePage('chrome://extensions').ok).toBe(false);
    expect(isInjectablePage('chrome-extension://abc/app.html').ok).toBe(false);
  });

  it('从链接中读取岗位 ID', () => {
    expect(extractJobId('https://jobs.example.com/apply?jobId=A12')).toBe('A12');
    expect(extractJobId('https://jobs.example.com/apply?unknown=A12')).toBeNull();
  });
});

describe('U08 CSV 往返', () => {
  const row = (over: Partial<CsvRow>): CsvRow => ({
    id: 'application-1', company: '星帆科技（演示）', role: 'AI 应用开发实习生', location: '杭州',
    sourceUrl: 'https://jobs.example.com/apply?jobId=A12', externalJobId: 'A12', profileVersionId: 'profile-demo-lin-v1',
    status: 'planned', blocker: 'none', createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
    appliedAt: '', nextAction: '', notes: '', ...over,
  });

  it('导出使用 BOM 与 CRLF', () => {
    const csv = toCsv([row({})]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('\r\n');
    expect(csv.split('\r\n')[0]!.replace('\ufeff', '')).toBe(CSV_COLUMNS.join(','));
  });

  it('逗号、双引号、换行与中文正确往返', () => {
    const tricky = row({ notes: '包含,逗号 "引号"\n和换行，以及中文', nextAction: '联系 HR，问“时间”' });
    const parsed = parseCsvRows(toCsv([tricky]));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.notes).toBe(tricky.notes);
    expect(parsed.rows[0]!.nextAction).toBe(tricky.nextAction);
  });

  it('公式保护前缀在往返后被正确还原', () => {
    const dangerous = row({ notes: '=SUM(A1:A2)', nextAction: '+123', company: '@提及', location: '-5' });
    const csv = toCsv([dangerous]);
    expect(csv).toContain(`,'=SUM(A1:A2)`);
    const parsed = parseCsvRows(csv);
    expect(parsed.rows[0]!.notes).toBe('=SUM(A1:A2)');
    expect(parsed.rows[0]!.nextAction).toBe('+123');
    expect(parsed.rows[0]!.company).toBe('@提及');
    expect(parsed.rows[0]!.location).toBe('-5');
  });

  it('普通文本不会被误加或误删前缀', () => {
    expect(protectFormula("正常文本")).toBe('正常文本');
    expect(unprotectFormula("'正常文本")).toBe("'正常文本");
    expect(unprotectFormula("'=1+1")).toBe('=1+1');
  });

  it('空值与电话号码按字符串处理', () => {
    const parsed = parseCsvRows(toCsv([row({ location: '', notes: '', externalJobId: '000000000001' })]));
    expect(parsed.rows[0]!.location).toBe('');
    expect(parsed.rows[0]!.externalJobId).toBe('000000000001');
  });

  it('缺少必需列时报错而不是猜测', () => {
    const parsed = parseCsvRows('id,company\r\n1,A\r\n');
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors[0]?.message).toContain('缺少列');
  });

  it('引号内的换行不会被当作新行', () => {
    const table = parseCsvTable('a,b\r\n"1\n2",3\r\n');
    expect(table).toHaveLength(2);
    expect(table[1]).toEqual(['1\n2', '3']);
  });

  it('已投递记录缺少 appliedAt 的行被跳过并给出行号', async () => {
    const result = await csvRowsToRecords([row({ status: 'applied', appliedAt: '' })], '2026-09-03T00:00:00.000Z');
    expect(result.records).toHaveLength(0);
    expect(result.issues[0]?.line).toBe(2);
  });

  it('导入的已投递记录带 imported 证据', async () => {
    const result = await csvRowsToRecords(
      [row({ status: 'applied', appliedAt: '2026-09-01T10:00:00.000Z' })],
      '2026-09-03T00:00:00.000Z',
    );
    expect(result.records[0]?.submissionEvidence?.kind).toBe('imported');
    expect(result.records[0]?.timeline[0]?.reason).toBe('历史导入');
  });

  it('记录导出后重新导入内容一致', async () => {
    const record: ApplicationRecord = {
      id: 'application-x', company: '星帆科技（演示）', role: 'AI 应用开发实习生（演示）', location: '杭州',
      sourceUrl: 'https://jobs.example.com/apply?jobId=A12', canonicalUrl: 'https://jobs.example.com/apply?jobId=A12',
      externalJobId: 'A12', dedupeKey: `sha256:${'a'.repeat(64)}`, profileVersionId: 'profile-demo-lin-v1',
      status: 'planned', blocker: 'none', createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
      appliedAt: null, nextAction: '准备笔试，注意"时间"', notes: '含逗号,与换行\n的备注', submissionEvidence: null,
      timeline: [{ at: '2026-09-03T00:00:00.000Z', from: null, to: 'planned', reason: '创建' }],
    };
    const parsed = parseCsvRows(exportCsv([record]));
    const restored = await csvRowsToRecords(parsed.rows, '2026-09-04T00:00:00.000Z');
    const before = recordToCsvRow(record);
    const after = recordToCsvRow(restored.records[0]!);
    for (const column of CSV_COLUMNS) {
      if (column === 'updatedAt') continue;
      expect(after[column]).toBe(before[column]);
    }
  });
});

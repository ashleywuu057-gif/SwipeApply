import { parseImportText } from '../shared/schemas';
import type { BackupFile } from '../shared/types';
import { byId, clear, describeError, downloadFile, el, formatBytes, on, send, toast, type StateView } from './common';

/** 备份页：导出完整备份、恢复备份、数据占用说明。备份是明文文件，不上传云端。 */

export function renderBackup(state: StateView, reload: () => void): void {
  const host = byId('view-backup');
  clear(host);

  host.append(
    el('div', { class: 'panel-head' }, [
      el('h2', { text: '备份与恢复' }),
      el('p', { class: 'muted', text: '备份文件是保存在你电脑上的明文 JSON，不会上传到任何服务器。请自行妥善保管。' }),
    ]),
  );

  const info = el('section', { class: 'card' }, [
    el('h3', { text: '当前数据' }),
    el('p', { text: `履历版本 ${state.profiles.length} 个 · 投递记录 ${state.applications.length} 条 · 规则 ${state.mappings.length} 条 · 运行报告 ${state.recentRuns.length} 条` }),
    el('p', { class: 'muted', text: `本地存储占用约 ${formatBytes(state.usageBytes)}（接近 7 MiB 时会拒绝继续增长并提示整理）` }),
    el('p', { class: 'muted', text: '卸载扩展会一并删除这些数据，请定期导出备份。' }),
  ]);

  const exportButton = el('button', { type: 'button', class: 'primary', id: 'btn-export-backup', text: '导出完整备份' });
  on(exportButton, 'click', () => {
    void send<BackupFile>('EXPORT_BACKUP')
      .then((backup) => {
        downloadFile(`applykit-backup-${Date.now()}.json`, JSON.stringify(backup, null, 2));
        toast('已导出完整备份', 'success');
      })
      .catch((error: unknown) => toast(describeError(error), 'error'));
  });
  info.append(exportButton);
  host.append(info);

  const restore = el('section', { class: 'card' }, [
    el('h3', { text: '恢复备份' }),
    el('p', { class: 'warn', text: '恢复会用备份文件整库替换当前数据。请先导出当前数据再操作。' }),
  ]);
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', id: 'backup-file' });
  const checkButton = el('button', { type: 'button', class: 'ghost', id: 'btn-check-backup', text: '校验并预览' });
  const preview = el('div', { class: 'preview' });
  on(checkButton, 'click', () => {
    const file = fileInput.files?.[0];
    if (!file) {
      toast('请先选择备份文件', 'error');
      return;
    }
    void previewBackup(file, state, preview, reload);
  });
  restore.append(fileInput, checkButton, preview);
  host.append(restore);
}

async function previewBackup(file: File, state: StateView, preview: HTMLElement, reload: () => void): Promise<void> {
  clear(preview);
  const raw = await file.text();
  const parsed = parseImportText(raw, 'applykit-backup');
  if (!parsed.ok) {
    preview.append(el('p', { class: 'error', text: '备份文件未通过校验，当前数据没有改变：' }));
    for (const issue of parsed.errors) preview.append(el('p', { class: 'error', text: `${issue.path}：${issue.message}` }));
    return;
  }
  const backup = parsed.value as BackupFile;
  const warnings: string[] = [];
  const versions = new Set(backup.state.profiles.map((profile) => profile.profileVersionId));
  for (const record of backup.state.applications) {
    if (record.profileVersionId && !versions.has(record.profileVersionId)) {
      warnings.push(`投递记录「${record.company} / ${record.role}」引用的履历版本不在备份中`);
    }
  }

  preview.append(
    el('div', { class: 'card' }, [
      el('h4', { text: '备份预览' }),
      el('p', { text: `导出时间：${backup.exportedAt}` }),
      el('p', { text: `履历 ${backup.state.profiles.length} 个 · 记录 ${backup.state.applications.length} 条 · 规则 ${backup.state.mappings.length} 条` }),
    ]),
  );
  for (const warning of warnings) preview.append(el('p', { class: 'warn', text: warning }));

  const confirm = el('button', { type: 'button', class: 'primary', id: 'btn-restore-backup', text: '确认整库替换' });
  on(confirm, 'click', () => {
    void send('IMPORT_BACKUP', { file: backup, expectedRevision: state.revision })
      .then(() => {
        toast('备份已恢复', 'success');
        reload();
      })
      .catch((error: unknown) => toast(describeError(error), 'error'));
  });
  preview.append(confirm);
}

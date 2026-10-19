import {
  contentMessageSchema, isContentSender, isTrustedUiSender, PROTOCOL_VERSION, uiMessageSchema,
  type ContentMessage, type Reply, type UiMessage,
} from '../shared/protocol';
import { validateFieldRef } from '../shared/field-catalog';
import { isInjectablePage } from '../shared/urls';
import type { AppState, ApplicationRecord, KnownSection, ProfileFile } from '../shared/types';
import {
  applyImport, buildRecord, confirmSubmitted, changeStatus, findDuplicates, planImport, putRecord,
} from './applications';
import {
  bindRecord, cancelRun, captureManual, getRun, handleFinished, handleProgress, locateField, prepareRun,
  reconcileActiveRuns, retryField, ruleScopeForField, fieldResultOf,
} from './coordinator';
import { importProfile, saveProfileVersion } from './profiles';
import { fetchJobprepProfile, notifyJobprepSubmitted } from './jobprep';
import { deleteMapping, upsertMapping } from './rules';
import { deleteRemembered, readRemembered, saveRemembered } from './remembered';
import {
  ensureInitialized, getState, getUnreadable, mutate, replaceState, usageBytes,
} from './storage';

/** 后台入口：所有消息监听在模块顶层注册。 */

let lastTargetTabId: number | null = null;

chrome.runtime.onInstalled.addListener(() => {
  // 只补缺省值，不清空资料。
  void ensureInitialized().then(() => reconcileActiveRuns());
});

chrome.runtime.onStartup.addListener(() => {
  void ensureInitialized().then(() => reconcileActiveRuns());
});

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const envelope = raw as { protocolVersion?: number; requestId?: string; type?: string; payload?: unknown };
  if (!envelope || envelope.protocolVersion !== PROTOCOL_VERSION || typeof envelope.requestId !== 'string') {
    return false;
  }
  const requestId = envelope.requestId;
  const extensionId = chrome.runtime.id;

  const fail = (code: string, message: string): Reply<never> => ({ ok: false, requestId, error: { code, message } });

  // 内容脚本只能回传已登记运行的扫描与进度。
  if (isContentSender(sender, extensionId)) {
    const parsed = contentMessageSchema.safeParse({ type: envelope.type, payload: envelope.payload });
    if (!parsed.success) {
      sendResponse(fail('FORBIDDEN', '内容脚本不能调用这个接口'));
      return false;
    }
    handleContentMessage(parsed.data, sender)
      .then(() => sendResponse({ ok: true, requestId, data: null }))
      .catch((error: unknown) => sendResponse(fail('CONTENT_ERROR', (error as Error).message)));
    return true;
  }

  if (!isTrustedUiSender(sender, extensionId)) {
    sendResponse(fail('FORBIDDEN', '只有扩展自己的页面可以调用管理接口'));
    return false;
  }

  const parsed = uiMessageSchema.safeParse({ type: envelope.type, payload: envelope.payload });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    sendResponse(fail('BAD_MESSAGE', first ? `${first.path.join('.')} ${first.message}` : '消息格式不正确'));
    return false;
  }

  handleUiMessage(parsed.data, requestId, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      const err = error as { code?: string; message?: string };
      sendResponse(fail(err.code ?? 'INTERNAL', err.message ?? '未知错误'));
    });
  return true;
});

async function handleContentMessage(message: ContentMessage, sender: chrome.runtime.MessageSender): Promise<void> {
  switch (message.type) {
    case 'REGISTER_DOCUMENT':
      // 记录内容脚本所在的实际 tab；不相信 payload 自报的来源。
      if (sender.tab?.id !== undefined) lastTargetTabId = sender.tab.id;
      return;
    case 'RUN_PROGRESS':
      await handleProgress(message.payload);
      return;
    case 'RUN_FINISHED':
      await handleFinished(message.payload);
      return;
  }
}

interface StateView {
  revision: number;
  activeProfileVersionId: string | null;
  profiles: ProfileFile[];
  applications: AppState['applications'];
  mappings: AppState['mappings'];
  recentRuns: AppState['recentRuns'];
  settings: AppState['settings'];
  usageBytes: number;
  unreadable: { reason: string; details: Array<{ path: string; message: string }> } | null;
}

async function buildStateView(): Promise<StateView> {
  await ensureInitialized();
  const unreadable = getUnreadable();
  if (unreadable) {
    return {
      revision: 0,
      activeProfileVersionId: null,
      profiles: [],
      applications: [],
      mappings: [],
      recentRuns: [],
      settings: { timezone: 'Asia/Shanghai' },
      usageBytes: 0,
      unreadable: { reason: unreadable.reason, details: unreadable.details },
    };
  }
  const state = await getState();
  return {
    revision: state.revision,
    activeProfileVersionId: state.activeProfileVersionId,
    profiles: state.profiles,
    applications: state.applications,
    mappings: state.mappings,
    recentRuns: state.recentRuns,
    settings: state.settings,
    usageBytes: await usageBytes(),
    unreadable: null,
  };
}

function ok<T>(requestId: string, data: T): Reply<T> {
  return { ok: true, requestId, data };
}

async function handleUiMessage(
  message: UiMessage,
  requestId: string,
  _sender: chrome.runtime.MessageSender,
): Promise<Reply<unknown>> {
  await ensureInitialized();

  switch (message.type) {
    case 'GET_STATE':
      return ok(requestId, await buildStateView());

    case 'GET_TARGET_TAB': {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const candidate = active && active.url ? active : null;
      if (candidate?.id !== undefined) lastTargetTabId = candidate.id;
      const tab = candidate ?? (lastTargetTabId !== null ? await chrome.tabs.get(lastTargetTabId).catch(() => null) : null);
      if (!tab || tab.id === undefined) {
        return ok(requestId, { tabId: null, url: null, title: null, injectable: false, message: '无法读取当前标签页，请从工具栏图标打开插件' });
      }
      const injectable = tab.url ? isInjectablePage(tab.url) : { ok: false as const, message: '无法读取页面地址' };
      return ok(requestId, {
        tabId: tab.id,
        url: tab.url ?? null,
        title: tab.title ?? null,
        injectable: injectable.ok,
        message: injectable.ok ? null : injectable.message,
      });
    }

    case 'LIST_TARGET_TABS': {
      // 只能看到扩展有权限查看的标签页；没有 host 权限时 url 为空。
      const tabs = await chrome.tabs.query({});
      return ok(
        requestId,
        tabs
          .filter((tab) => tab.id !== undefined && typeof tab.url === 'string' && isInjectablePage(tab.url).ok)
          .map((tab) => ({ tabId: tab.id!, url: tab.url!, title: tab.title ?? '' })),
      );
    }

    case 'IMPORT_PROFILE': {
      const outcome = await mutate({ requestId, expectedRevision: message.payload.expectedRevision }, ({ state }) => {
        const result = importProfile(state, message.payload.file as ProfileFile, message.payload.onConflict);
        return { state: result.state, data: result.outcome };
      });
      return ok(requestId, outcome ?? { kind: 'idempotent' });
    }

    case 'SYNC_JOBPREP': {
      // 内容相同的履历版本号相同，重复同步是幂等的
      const fetched = await fetchJobprepProfile(message.payload.targetUrl);
      const outcome = await mutate({ requestId, expectedRevision: message.payload.expectedRevision }, ({ state }) => {
        const result = importProfile(state, fetched.file, 'save-as-new');
        return { state: result.state, data: result.outcome };
      });
      return ok(requestId, { outcome, name: fetched.file.name, job: fetched.job });
    }

    case 'SAVE_PROFILE': {
      const result = await mutate({ requestId, expectedRevision: message.payload.expectedRevision }, ({ state }) => {
        const saved = saveProfileVersion(
          state,
          message.payload.profileId,
          message.payload.name,
          message.payload.data,
        );
        return { state: saved.state, data: { profileVersionId: saved.profileVersionId } };
      });
      return ok(requestId, result ?? {});
    }

    case 'SET_ACTIVE_PROFILE': {
      const result = await mutate({ requestId, expectedRevision: message.payload.expectedRevision }, ({ state }) => {
        const exists = state.profiles.some((profile) => profile.profileVersionId === message.payload.profileVersionId);
        if (!exists) throw Object.assign(new Error('找不到这个履历版本'), { code: 'PROFILE_NOT_FOUND' });
        return {
          state: { ...state, activeProfileVersionId: message.payload.profileVersionId },
          data: { activeProfileVersionId: message.payload.profileVersionId },
        };
      });
      return ok(requestId, result ?? {});
    }

    case 'PREPARE_RUN':
      return ok(requestId, await prepareRun(message.payload));

    case 'GET_RUN':
      return ok(requestId, await getRun(message.payload.runId));

    case 'CANCEL_RUN': {
      await cancelRun(message.payload.runId);
      return ok(requestId, { cancelled: true });
    }

    case 'BIND_RECORD': {
      const result = await bindRecord({
        runId: message.payload.runId,
        recordInstanceId: message.payload.recordInstanceId,
        recordId: message.payload.recordId,
      });
      return ok(requestId, result);
    }

    // jobprep：记住你手动补填的内容
    case 'CAPTURE_MANUAL':
      return ok(requestId, await captureManual(message.payload.runId));

    case 'SAVE_REMEMBERED': {
      const items = message.payload.items
        .filter((item) => item.section !== 'unknown')
        .map((item) => ({ ...item, section: item.section as KnownSection, origin: message.payload.origin }));
      const list = await saveRemembered(items);
      return ok(requestId, { saved: items.length, total: list.length });
    }

    case 'LIST_REMEMBERED':
      return ok(requestId, { items: await readRemembered() });

    case 'DELETE_REMEMBERED':
      return ok(requestId, { items: await deleteRemembered(message.payload.id) });

    case 'LOCATE_FIELD': {
      await locateField(message.payload.runId, message.payload.fieldId);
      return ok(requestId, { located: true });
    }

    case 'RETRY_FIELD': {
      const validation = validateFieldRef(message.payload.source);
      if (!validation.ok) throw Object.assign(new Error(validation.message), { code: 'BAD_FIELD_REF' });

      const result = await retryField({
        runId: message.payload.runId,
        fieldId: message.payload.fieldId,
        source: message.payload.source,
        overwriteExisting: message.payload.overwriteExisting,
      });

      let mappingSaved = false;
      // 只有实际填写并通过回读验证后，才写入规则。
      if (message.payload.remember && result.verified) {
        const scope = ruleScopeForField(message.payload.runId, message.payload.fieldId);
        const state = await getState();
        await mutate({ requestId: `${requestId}-mapping` }, ({ state: current }) => {
          const saved = upsertMapping(
            current,
            {
              scope: scope.scope,
              section: message.payload.source.section,
              fieldLabel: scope.descriptor.label,
              controlKind: scope.descriptor.controlKind as never,
              fieldFingerprint: scope.descriptor.fingerprint,
              sourceField: message.payload.source.field,
              recordSelector: buildRecordSelector(state, message.payload.source),
            },
            new Date().toISOString(),
          );
          return { state: saved.state, data: saved.mapping };
        });
        mappingSaved = true;
      }

      return ok(requestId, { ...result, mappingSaved });
    }

    case 'SAVE_MAPPING': {
      const validation = validateFieldRef(message.payload.source);
      if (!validation.ok) throw Object.assign(new Error(validation.message), { code: 'BAD_FIELD_REF' });
      const field = fieldResultOf(message.payload.runId, message.payload.fieldId);
      if (!field || field.outcome !== 'filled') {
        throw Object.assign(new Error('只有实际填写并验证成功的字段才能保存为规则'), { code: 'NOT_VERIFIED' });
      }
      const scope = ruleScopeForField(message.payload.runId, message.payload.fieldId);
      const result = await mutate({ requestId, expectedRevision: message.payload.expectedRevision }, ({ state }) => {
        const saved = upsertMapping(
          state,
          {
            scope: scope.scope,
            section: message.payload.source.section,
            fieldLabel: scope.descriptor.label,
            controlKind: scope.descriptor.controlKind as never,
            fieldFingerprint: scope.descriptor.fingerprint,
            sourceField: message.payload.source.field,
            recordSelector: message.payload.recordSelector,
          },
          new Date().toISOString(),
        );
        return { state: saved.state, data: saved.mapping };
      });
      return ok(requestId, result ?? {});
    }

    case 'DELETE_MAPPING': {
      const result = await mutate({ requestId, expectedRevision: message.payload.expectedRevision }, ({ state }) => ({
        state: deleteMapping(state, message.payload.mappingId),
        data: { deleted: true },
      }));
      return ok(requestId, result ?? {});
    }

    case 'UPSERT_APPLICATION': {
      const payload = message.payload;
      const state = await getState();
      const now = new Date().toISOString();
      const built = await buildRecord(state, {
        id: payload.record.id,
        company: payload.record.company,
        role: payload.record.role,
        location: payload.record.location,
        sourceUrl: payload.record.sourceUrl,
        canonicalUrl: payload.record.canonicalUrl,
        externalJobId: payload.record.externalJobId,
        profileVersionId: payload.record.profileVersionId,
        status: payload.record.status,
        blocker: payload.record.blocker,
        nextAction: payload.record.nextAction,
        notes: payload.record.notes,
      }, now);

      const duplicates = findDuplicates(state, built.record);
      if (duplicates.exact && !payload.allowDuplicate) {
        return ok(requestId, {
          saved: false,
          duplicate: {
            id: duplicates.exact.id,
            company: duplicates.exact.company,
            role: duplicates.exact.role,
            status: duplicates.exact.status,
          },
          similar: duplicates.similar.map((entry) => ({ id: entry.id, company: entry.company, role: entry.role })),
          confidence: duplicates.confidence,
        });
      }

      const saved = await mutate({ requestId, expectedRevision: payload.expectedRevision }, ({ state: current }) => ({
        state: putRecord(current, built.record),
        data: { saved: true, id: built.record.id },
      }));
      return ok(requestId, {
        ...(saved ?? { saved: true, id: built.record.id }),
        similar: duplicates.similar.map((entry) => ({ id: entry.id, company: entry.company, role: entry.role })),
        confidence: duplicates.confidence,
      });
    }

    case 'CONFIRM_SUBMITTED': {
      const now = new Date().toISOString();
      let submitted: ApplicationRecord | null = null;
      const result = await mutate({ requestId, expectedRevision: message.payload.expectedRevision }, ({ state }) => {
        const record = state.applications.find((entry) => entry.id === message.payload.recordId);
        if (!record) throw Object.assign(new Error('找不到这条投递记录'), { code: 'NOT_FOUND' });
        const updated = confirmSubmitted({
          record,
          appliedAt: message.payload.appliedAt,
          note: message.payload.note,
          now,
        });
        submitted = updated;
        return { state: putRecord(state, updated), data: { status: updated.status, appliedAt: updated.appliedAt } };
      });
      if (submitted) notifyJobprepSubmitted(submitted); // jobprep：记进SwipeApply的「我的投递」
      return ok(requestId, result ?? {});
    }

    case 'SET_APPLICATION_STATUS': {
      const now = new Date().toISOString();
      const result = await mutate({ requestId, expectedRevision: message.payload.expectedRevision }, ({ state }) => {
        const record = state.applications.find((entry) => entry.id === message.payload.recordId);
        if (!record) throw Object.assign(new Error('找不到这条投递记录'), { code: 'NOT_FOUND' });
        const updated = changeStatus({
          record,
          next: message.payload.status,
          blocker: message.payload.blocker,
          reason: message.payload.reason,
          now,
        });
        return { state: putRecord(state, updated), data: { status: updated.status } };
      });
      return ok(requestId, result ?? {});
    }

    case 'IMPORT_APPLICATIONS': {
      const state = await getState();
      const plan = planImport(state, message.payload.records);
      const result = await mutate({ requestId, expectedRevision: message.payload.expectedRevision }, ({ state: current }) => {
        const applied = applyImport(current, message.payload.records, message.payload.strategy);
        return {
          state: applied.state,
          data: { added: applied.added, skipped: applied.skipped, replaced: applied.replaced },
        };
      });
      return ok(requestId, {
        ...(result ?? { added: 0, skipped: 0, replaced: 0 }),
        preview: {
          identical: plan.identical.length,
          conflictsById: plan.conflictsById.length,
          conflictsByKey: plan.conflictsByKey.length,
          fresh: plan.fresh.length,
        },
      });
    }

    case 'EXPORT_BACKUP': {
      const state = await getState();
      return ok(requestId, {
        kind: 'applykit-backup' as const,
        schemaVersion: 1 as const,
        exportedAt: new Date().toISOString(),
        state,
      });
    }

    case 'IMPORT_BACKUP': {
      const restored = await replaceState(message.payload.file.state as AppState, requestId);
      return ok(requestId, {
        profiles: restored.profiles.length,
        applications: restored.applications.length,
        mappings: restored.mappings.length,
      });
    }
  }
}

function buildRecordSelector(state: AppState, source: { section: string; recordId?: string }) {
  if (!source.recordId) return { kind: 'single' as const };
  const profile = state.profiles.find((entry) => entry.profileVersionId === state.activeProfileVersionId);
  if (profile && source.section === 'education') {
    const record = profile.data.education.find((entry) => entry.id === source.recordId);
    if (record) {
      const sameLevel = profile.data.education.filter((entry) => entry.degreeLevel === record.degreeLevel);
      // degree 选择器只在同层级唯一时生效。
      if (sameLevel.length === 1) return { kind: 'degree' as const, level: record.degreeLevel };
    }
  }
  return {
    kind: 'record' as const,
    profileId: profile?.profileId ?? 'unknown',
    recordId: source.recordId,
  };
}

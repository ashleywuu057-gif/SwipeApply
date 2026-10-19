import {
  backgroundCommandSchema, makeEnvelope, PROTOCOL_VERSION, type BackgroundCommand, type Reply,
} from '../shared/protocol';
import { buildRouteKey } from '../shared/urls';
import { selectAdapter } from './adapters/registry';
import { highlight } from './highlight';
import { DEFAULT_BUDGET_MS, executePlan, runAddRequests } from './executor';
import { scanPage, type ScanOutput } from './scanner';
import { readCurrentValue } from './verify';
import { normalizeText } from '../shared/normalize';

/** 内容脚本入口：注入幂等、命令分发、页面生命周期。 */

// 编辑器重载扩展后，旧标签页可能仍保留上一版隔离世界标记。
// 能力变更时提升该值，使下一次一键填写能启动新内容脚本。
const CONTENT_VERSION = '17';
const MARK = '__applykitContentVersion';

declare global {
  interface Window {
    __applykitContentVersion?: string;
  }
}

// 隔离世界内的版本标记，防止重复绑定事件。
if (window[MARK] === CONTENT_VERSION) {
  // 已注入，无需重复初始化。
} else {
  window[MARK] = CONTENT_VERSION;
  start();
}

interface RunState {
  runId: string;
  nonce: string;
  cancelled: boolean;
  running: boolean;
  seq: number;
}

function start(): void {
  let scan: ScanOutput | null = null;
  let run: RunState | null = null;
  let routeKey = buildRouteKey(location.href);
  let stale = false;

  const markStale = () => {
    stale = true;
  };
  window.addEventListener('pagehide', markStale);
  window.addEventListener('beforeunload', markStale);

  // 单页应用路由变化同样使旧计划失效。
  const routeObserver = new MutationObserver(() => {
    const current = buildRouteKey(location.href);
    if (current !== routeKey) {
      routeKey = current;
      stale = true;
    }
  });
  routeObserver.observe(document.documentElement, { childList: true, subtree: true });

  const doScan = (): ScanOutput => {
    const selection = selectAdapter({
      origin: location.origin,
      pathname: location.pathname,
      document,
    });
    scan = scanPage({
      adapter: selection.adapter,
      adapterFallbackReason: selection.reason,
      document,
    });
    return scan;
  };

  const getScan = (): ScanOutput => scan ?? doScan();

  const send = (type: string, payload: unknown): void => {
    try {
      void chrome.runtime.sendMessage(makeEnvelope(type, payload));
    } catch {
      // 后台不可用时静默失败：下次打开插件会标记为中断。
    }
  };

  send('REGISTER_DOCUMENT', {
    url: location.href,
    title: document.title.slice(0, 300),
    contentVersion: CONTENT_VERSION,
  });

  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    const envelope = raw as { protocolVersion?: number; requestId?: string; type?: string; payload?: unknown };
    if (!envelope || envelope.protocolVersion !== PROTOCOL_VERSION || typeof envelope.requestId !== 'string') {
      return false;
    }
    const parsed = backgroundCommandSchema.safeParse({ type: envelope.type, payload: envelope.payload });
    if (!parsed.success) {
      sendResponse({ ok: false, requestId: envelope.requestId, error: { code: 'BAD_MESSAGE', message: '不支持的消息' } });
      return false;
    }
    const requestId = envelope.requestId;
    handleCommand(parsed.data, requestId)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          requestId,
          error: { code: 'CONTENT_ERROR', message: (error as Error).message },
        });
      });
    return true;
  });

  async function handleCommand(command: BackgroundCommand, requestId: string): Promise<Reply<unknown>> {
    const ok = (data: unknown): Reply<unknown> => ({ ok: true, requestId, data });
    const fail = (code: string, message: string): Reply<unknown> => ({ ok: false, requestId, error: { code, message } });

    switch (command.type) {
      case 'SCAN_PAGE': {
        // 新的一次扫描针对的是当前页面：单页应用（例如飞书招聘从岗位列表点进申请表）换过路由后，
        // stale 只说明"上一轮的扫描结果失效了"，不能挡住重新扫描，否则这个标签页就再也扫不了。
        stale = false;
        routeKey = buildRouteKey(location.href);
        scan = null;
        run = { runId: command.payload.runId, nonce: command.payload.nonce, cancelled: false, running: false, seq: 0 };
        const output = doScan();
        return ok(output.result);
      }

      case 'ADD_RECORDS': {
        if (!run || run.runId !== command.payload.runId || run.nonce !== command.payload.nonce) {
          return fail('UNKNOWN_RUN', '这一轮运行已经结束');
        }
        if (stale) return fail('STALE_PAGE', '页面已经跳转或刷新');
        const notes = await runAddRequests({
          runId: run.runId,
          actions: [],
          addRequests: command.payload.requests,
          budgetMs: 10_000,
          getScan,
          rescan: doScan,
          onProgress: () => undefined,
          isCancelled: () => run?.cancelled ?? true,
          isStale: () => stale,
        });
        const output = doScan();
        return ok({ scan: output.result, notes });
      }

      case 'EXECUTE_PLAN': {
        if (!run || run.runId !== command.payload.runId || run.nonce !== command.payload.nonce) {
          return fail('UNKNOWN_RUN', '这一轮运行已经结束');
        }
        if (run.running) return fail('ALREADY_RUNNING', '这一轮填写正在进行中');
        if (stale) return fail('STALE_PAGE', '页面已经跳转或刷新');
        run.running = true;
        const current = run;

        // 立即回应，填写过程通过 RUN_PROGRESS / RUN_FINISHED 上报，弹窗关闭后继续。
        void (async () => {
          try {
            const summary = await executePlan({
              runId: current.runId,
              actions: command.payload.actions,
              addRequests: [],
              budgetMs: command.payload.budgetMs || DEFAULT_BUDGET_MS,
              getScan,
              rescan: doScan,
              onProgress: (completed, total, outcome) => {
                current.seq += 1;
                send('RUN_PROGRESS', {
                  runId: current.runId,
                  nonce: current.nonce,
                  seq: current.seq,
                  completed,
                  total,
                  outcome,
                });
              },
              isCancelled: () => current.cancelled,
              isStale: () => stale,
            });
            // 先释放运行锁，再通知后台。后台可能立刻发起一次针对动态新增字段的
            // 补充执行；若仍保持 running=true，会把合法的第二轮误判为并发运行。
            current.running = false;
            current.seq += 1;
            send('RUN_FINISHED', {
              runId: current.runId,
              nonce: current.nonce,
              seq: current.seq,
              phase: summary.phase,
              outcomes: summary.outcomes,
              message: summary.message,
            });
          } catch (error) {
            current.running = false;
            current.seq += 1;
            send('RUN_FINISHED', {
              runId: current.runId,
              nonce: current.nonce,
              seq: current.seq,
              phase: 'failed',
              outcomes: [],
              message: (error as Error).message.slice(0, 200),
            });
          } finally {
            current.running = false;
          }
        })();

        return ok({ started: true, total: command.payload.actions.length });
      }

      case 'CANCEL_EXECUTION': {
        if (!run || run.runId !== command.payload.runId || run.nonce !== command.payload.nonce) {
          return fail('UNKNOWN_RUN', '这一轮运行已经结束');
        }
        run.cancelled = true;
        return ok({ cancelled: true });
      }

      case 'HIGHLIGHT_FIELD': {
        if (!run || run.runId !== command.payload.runId || run.nonce !== command.payload.nonce) {
          return fail('UNKNOWN_RUN', '这一轮运行已经结束');
        }
        const entry = getScan().entries.get(command.payload.fieldId);
        if (!entry) return fail('FIELD_NOT_FOUND', '页面上找不到这个字段，可能已经变化');
        highlight(entry.primary, 2000);
        return ok({ located: true });
      }

      case 'PING_RUN': {
        const alive = run !== null && run.runId === command.payload.runId && run.nonce === command.payload.nonce;
        return ok({ alive, running: alive ? run!.running : false, stale });
      }

      case 'READ_FIELD_VALUES': {
        if (!run || run.runId !== command.payload.runId || run.nonce !== command.payload.nonce) {
          return fail('UNKNOWN_RUN', '这一轮运行已经结束，请重新扫描');
        }
        if (run.running) return fail('ALREADY_RUNNING', '还在填写中，等它结束再记');
        // 重新扫一遍（不覆盖本轮的扫描结果），按字段指纹 + 所在经历找到对应控件，读现在的值
        const selection = selectAdapter({ origin: location.origin, pathname: location.pathname, document });
        const fresh = scanPage({ adapter: selection.adapter, adapterFallbackReason: selection.reason, document });
        const descriptors = fresh.result.descriptors;
        const valueOf = (fieldId: string) => {
          const entry = fresh.entries.get(fieldId);
          return entry ? normalizeText(readCurrentValue(entry)) : '';
        };
        /** 经历类字段属于哪段经历：同一张卡片里学校 / 公司 / 项目名称 / 语言的值 */
        const identityOf = (recordInstanceId: string | null) => {
          if (!recordInstanceId) return null;
          const id = descriptors.find((d) => d.recordInstanceId === recordInstanceId && /学校|公司|单位|项目名称|语种|语言/.test(d.normalizedLabel));
          return id ? valueOf(id.fieldId) || null : null;
        };
        const values = command.payload.fields.flatMap((want) => {
          const hits = descriptors.filter((d) => d.semanticFingerprint === want.fingerprint && d.recordInstanceId === want.recordInstanceId);
          if (hits.length !== 1) return [];
          const value = valueOf(hits[0]!.fieldId);
          return value ? [{ ...want, value: value.slice(0, 2000), recordIdentity: identityOf(want.recordInstanceId) }] : [];
        });
        return ok({ values });
      }
    }
  }
}

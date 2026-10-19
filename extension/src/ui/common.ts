import { makeEnvelope, type Reply } from '../shared/protocol';
import type { ApplicationRecord, AppSettings, ProfileFile, RunReport, SavedMapping } from '../shared/types';

/** UI 公共工具：消息发送与安全 DOM 构建（只用 textContent，不拼 HTML）。 */

export interface StateView {
  revision: number;
  activeProfileVersionId: string | null;
  profiles: ProfileFile[];
  applications: ApplicationRecord[];
  mappings: SavedMapping[];
  recentRuns: RunReport[];
  settings: AppSettings;
  usageBytes: number;
  unreadable: { reason: string; details: Array<{ path: string; message: string }> } | null;
}

export class RequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RequestError';
  }
}

export async function send<T>(type: string, payload: unknown = {}): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(makeEnvelope(type, payload))) as Reply<T> | undefined;
  if (!reply) throw new RequestError('NO_REPLY', '后台没有回应，请重新打开扩展页面');
  if (!reply.ok) throw new RequestError(reply.error.code, reply.error.message);
  return reply.data;
}

export function getState(): Promise<StateView> {
  return send<StateView>('GET_STATE');
}

type Attrs = Record<string, string | number | boolean | undefined | null>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'value' && node instanceof HTMLInputElement) node.value = String(value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.firstChild.remove();
}

export function on<K extends keyof HTMLElementEventMap>(
  node: Element,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): void {
  node.addEventListener(type, handler as EventListener);
}

export function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`找不到界面元素 #${id}`);
  return node as T;
}

export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  const host = document.getElementById('toast-host') ?? document.body;
  const node = el('div', { class: `toast toast-${kind}`, role: 'status', text: message });
  host.append(node);
  setTimeout(() => node.remove(), 6000);
}

export function describeError(error: unknown): string {
  if (error instanceof RequestError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 导出文件：使用扩展页面内的 Blob 与带 download 属性的链接。 */
export function downloadFile(filename: string, content: string, mime = 'application/json'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

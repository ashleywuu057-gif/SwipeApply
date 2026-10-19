import { EXTENSION_MARK } from './dom-utils';

/** 页面内的短暂高亮与进度提示。不显示任何个人信息。 */

const STYLE_ID = 'applykit-style';
const TOAST_ID = 'applykit-toast';

function ensureStyle(document: Document): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.setAttribute(EXTENSION_MARK, 'style');
  style.textContent = `
    [${EXTENSION_MARK}-highlight] {
      outline: 2px solid #2f6bff !important;
      outline-offset: 1px !important;
      transition: outline-color .2s ease;
    }
    #${TOAST_ID} {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      background: #10233f; color: #fff; font: 13px/1.5 system-ui, sans-serif;
      padding: 8px 12px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.28);
      max-width: 260px; pointer-events: none;
    }
  `;
  document.head.append(style);
}

export function highlight(element: Element, durationMs = 1200): void {
  const document = element.ownerDocument;
  ensureStyle(document);
  element.setAttribute(`${EXTENSION_MARK}-highlight`, '1');
  element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => element.removeAttribute(`${EXTENSION_MARK}-highlight`), durationMs);
}

export function showProgress(document: Document, text: string): void {
  ensureStyle(document);
  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = TOAST_ID;
    toast.setAttribute(EXTENSION_MARK, 'toast');
    document.body.append(toast);
  }
  // 只显示计数与状态，绝不显示字段值。
  toast.textContent = text;
}

export function hideProgress(document: Document, delayMs = 2500): void {
  const toast = document.getElementById(TOAST_ID);
  if (!toast) return;
  setTimeout(() => toast.remove(), delayMs);
}

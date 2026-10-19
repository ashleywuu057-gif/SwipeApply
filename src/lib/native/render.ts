import "server-only";

/**
 * 用你电脑上已经装好的 Edge / Chrome 在后台（无窗口）打开网页，等页面里的脚本把内容加载出来再读文字。
 * 校招官网大多是"动态页面"：直接下载网页只能拿到一个空壳，内容是打开后才加载的；银行类网站的证书链
 * Node 常常不认，浏览器能打开。这里不下载额外的浏览器（用 playwright-core 驱动系统里的 Edge / Chrome）。
 *
 * 可以在 .env.local 里用 JD_BROWSER_PATH 指定浏览器程序的路径。
 */

type Browser = import("playwright-core").Browser;
type G = { __jdBrowser?: Promise<Browser> | null; __jdBrowserTimer?: NodeJS.Timeout; __jdQueue?: Promise<unknown> };
const g = globalThis as unknown as G;

async function launch(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const path = process.env.JD_BROWSER_PATH?.trim();
  const tries: Parameters<typeof chromium.launch>[0][] = path ? [{ executablePath: path }] : [{ channel: "msedge" }, { channel: "chrome" }];
  let last: unknown;
  for (const t of tries) {
    try {
      return await chromium.launch({ ...t, headless: true });
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`没有找到可用的 Edge / Chrome（可以在 .env.local 设置 JD_BROWSER_PATH）：${(last as Error)?.message?.split("\n")[0] ?? ""}`);
}

function browser() {
  if (!g.__jdBrowser) {
    g.__jdBrowser = launch().catch((e) => {
      g.__jdBrowser = null;
      throw e;
    });
  }
  // 空闲 2 分钟自动关掉，不常驻
  clearTimeout(g.__jdBrowserTimer);
  g.__jdBrowserTimer = setTimeout(async () => {
    const b = await g.__jdBrowser?.catch(() => null);
    g.__jdBrowser = null;
    await b?.close().catch(() => undefined);
  }, 120_000);
  return g.__jdBrowser;
}

export interface Rendered {
  url: string; // 最终地址（跳转之后）
  title: string;
  text: string;
  links: { text: string; href: string }[];
}

/** 一次只开一个页面，免得同时预取好几张卡片时把电脑拖慢 */
export function renderPage(url: string, timeoutMs = 25_000): Promise<Rendered> {
  const run = (g.__jdQueue ?? Promise.resolve()).then(() => renderOnce(url, timeoutMs));
  g.__jdQueue = run.catch(() => undefined);
  return run;
}

async function renderOnce(url: string, timeoutMs: number): Promise<Rendered> {
  if (!/^https?:\/\//.test(url)) throw new Error("不是有效的网址");
  const b = await browser();
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, locale: "zh-CN", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    // 不加载图片、字体、视频，快一些
    await page.route("**/*", (r) => (["image", "font", "media"].includes(r.request().resourceType()) ? r.abort() : r.continue()));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
    // 有些页面要滚一下才加载
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
    await page.waitForTimeout(800);
    const data = await page.evaluate(() => ({
      title: document.title,
      text: document.body?.innerText ?? "",
      links: [...document.querySelectorAll("a[href]")]
        .map((a) => ({ text: (a as HTMLAnchorElement).innerText.trim().slice(0, 60), href: (a as HTMLAnchorElement).href }))
        .filter((l) => l.text && /^https?:/.test(l.href))
        .slice(0, 400),
    }));
    return { url: page.url(), ...data, text: data.text.replace(/\n\s*\n+/g, "\n").slice(0, 60000) };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

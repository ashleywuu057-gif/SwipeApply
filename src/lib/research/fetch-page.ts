import "server-only";

/** 读取网页正文（在你电脑上直接抓取，只取文字）。公众号文章取 #js_content 部分。 */
export async function fetchPage(url: string): Promise<{ title: string; text: string; date?: string }> {
  if (!/^https?:\/\//.test(url)) throw new Error("不是有效的网址");
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`打开失败（${res.status}）`);
  const type = res.headers.get("content-type") ?? "";
  if (/pdf/.test(type) || /\.pdf($|\?)/i.test(url)) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
    const { text } = await extractText(pdf, { mergePages: true });
    return { title: url.split("/").pop() ?? url, text: squeeze(String(text)).slice(0, 60000) };
  }
  const html = await res.text();
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? html.match(/var msg_title = '([^']+)'/)?.[1] ?? "").trim();
  const date =
    html.match(/"datePublished"\s*:\s*"([\d-]{10})/)?.[1] ??
    html.match(/<meta[^>]+(?:article:published_time|pubdate|publishdate)[^>]+content="([\d-]{10})/i)?.[1] ??
    html.match(/var ct = "(\d{10})"/)?.[1]?.replace(/^(\d+)$/, (s) => new Date(Number(s) * 1000).toISOString().slice(0, 10));

  let body = html;
  const wx = html.match(/<div[^>]+id="js_content"[^>]*>([\s\S]*?)<\/div>\s*<script/i);
  if (wx) body = wx[1];
  else {
    const article = html.match(/<article[\s\S]*?<\/article>/i) ?? html.match(/<main[\s\S]*?<\/main>/i);
    if (article) body = article[0];
  }
  const text = squeeze(
    decode(
      body
        .replace(/<(script|style|noscript|svg|nav|footer|header|aside)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section)>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    ),
  );
  if (text.length < 80) throw new Error("没有读到正文（可能需要登录或是动态页面）");
  return { title, text: text.slice(0, 60000), date };
}

function squeeze(s: string) {
  return s.replace(/[ \t 　]+/g, " ").replace(/\n\s*\n\s*/g, "\n").trim();
}

function decode(s: string) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** 摘录核对用：去掉空白和标点后比较 */
export function normForQuote(s: string) {
  return s.replace(/[\s 　，。、；：！？,.;:!?“”"'‘’（）()【】\[\]《》<>\-—…·]/g, "").toLowerCase();
}

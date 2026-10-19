import "server-only";
import { promises as fs } from "fs";
import path from "path";

/**
 * 图片文字识别：用开源的 Tesseract 在本机完成，图片不会发给任何服务。
 * 中文 + 英文识别语言包随 npm install 下载到 node_modules，首次使用时复制到 data/ocr。
 */
const LANGS = ["eng", "chi_sim"]; // 顺序不能反：chi_sim 在前会触发 tesseract 的误报
const OCR_DIR = path.join(process.cwd(), "data", "ocr");

type Worker = Awaited<ReturnType<typeof import("tesseract.js").createWorker>>;
let workerPromise: Promise<Worker> | null = null;

async function prepareLangData() {
  await fs.mkdir(OCR_DIR, { recursive: true });
  for (const lang of LANGS) {
    const dest = path.join(OCR_DIR, `${lang}.traineddata.gz`);
    try {
      await fs.access(dest);
    } catch {
      const src = path.join(process.cwd(), "node_modules", "@tesseract.js-data", lang, "4.0.0_best_int", `${lang}.traineddata.gz`);
      await fs.copyFile(src, dest).catch(() => {
        throw new Error(`找不到 OCR 语言包 ${lang}，请先运行 npm install`);
      });
    }
  }
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      await prepareLangData();
      const { createWorker, OEM } = await import("tesseract.js");
      // 语言包直接从 data/ocr 读取，不另写缓存
      return createWorker(LANGS, OEM.LSTM_ONLY, { langPath: OCR_DIR, cacheMethod: "none", gzip: true });
    })().catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

export async function ocrImage(buf: Buffer): Promise<string> {
  const worker = await getWorker();
  const { data } = await worker.recognize(buf);
  return (
    data.text
      // Tesseract 识别中文时会在字之间加空格，去掉
      .replace(/([一-龥　-〿＀-￯])\s+(?=[一-龥　-〿＀-￯])/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

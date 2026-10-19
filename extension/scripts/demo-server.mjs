import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './build-lib.mjs';

// 只暴露 demo/ 目录与明确列出的虚构 fixture，不把项目或用户目录当作静态根。
const DEMO_DIR = path.join(ROOT, 'demo');
const ALLOWED_FIXTURES = new Map([
  ['/fixtures/profile.demo.json', path.join(ROOT, 'fixtures/profile.demo.json')],
  ['/fixtures/applications.demo.json', path.join(ROOT, 'fixtures/applications.demo.json')],
]);

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}));

const PORT = Number(process.env.APPLYKIT_DEMO_PORT ?? 4173);
const HOST = '127.0.0.1';

async function resolveFile(urlPath) {
  if (ALLOWED_FIXTURES.has(urlPath)) return ALLOWED_FIXTURES.get(urlPath);
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const resolved = path.join(DEMO_DIR, path.normalize(requested));
  if (resolved !== DEMO_DIR && !resolved.startsWith(DEMO_DIR + path.sep)) return null;
  return resolved;
}

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', `http://${HOST}:${PORT}`).pathname);
    const file = await resolveFile(urlPath);
    if (!file) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 目录越界');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES.get(path.extname(file)) ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 未找到');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[demo] http://${HOST}:${PORT}/basic.html`);
  console.log(`[demo] http://${HOST}:${PORT}/experience.html`);
  console.log(`[demo] http://${HOST}:${PORT}/edge-cases.html`);
});

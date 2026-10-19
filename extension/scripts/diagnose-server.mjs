import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './build-lib.mjs';

/**
 * 只为兼容性诊断服务的一次性本地服务器。
 *
 * 它只提供一个文件：.diagnose/applykit-diagnose.js（只读 DOM 的诊断代码，不含任何个人数据）。
 * 因为要从 https 招聘页面加载本地脚本，这里显式允许跨源与「私有网络访问」。
 * 用完请关掉；它不是扩展的一部分，也不参与 npm run demo。
 */

const FILE = path.join(ROOT, '.diagnose/applykit-diagnose.js');
const PORT = Number(process.env.APPLYKIT_DIAGNOSE_PORT ?? 4174);
const HOST = '127.0.0.1';

const server = createServer(async (req, res) => {
  const headers = {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-private-network': 'true',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': '*',
    'cache-control': 'no-store',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  if (!req.url?.startsWith('/applykit-diagnose.js')) {
    res.writeHead(404, headers);
    res.end('404');
    return;
  }
  try {
    const body = await readFile(FILE);
    res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' });
    res.end(body);
  } catch {
    res.writeHead(500, headers);
    res.end('缺少 .diagnose/applykit-diagnose.js，请先运行 npm run build:diagnose');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[diagnose] http://${HOST}:${PORT}/applykit-diagnose.js`);
  console.log('[diagnose] 仅供本地兼容性诊断，用完请关闭。');
});

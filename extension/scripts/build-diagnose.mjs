import path from 'node:path';
import * as esbuild from 'esbuild';
import { ROOT, cleanDir } from './build-lib.mjs';

// 兼容性诊断包：可以粘到任意招聘页面的控制台里运行，只读取 DOM。
const outdir = path.join(ROOT, '.diagnose');
await cleanDir(outdir);
await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/diagnose/index.ts')],
  outfile: path.join(outdir, 'applykit-diagnose.js'),
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('[diagnose] .diagnose/applykit-diagnose.js 已生成');
console.log('[diagnose] 用法：把该文件内容粘贴到招聘页面的控制台，然后运行 __applykitDiagnose()');

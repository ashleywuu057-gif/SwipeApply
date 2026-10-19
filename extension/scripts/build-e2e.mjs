import path from 'node:path';
import { ROOT, cleanDir, bundle, copyPublic, verifyManifestReferences } from './build-lib.mjs';

// 测试构建：仅此产物增加 loopback host 权限，便于 Playwright 无工具栏点击时注入脚本。
const outdir = path.join(ROOT, '.test-dist');

await cleanDir(outdir);
const manifest = await copyPublic(outdir, (m) => ({
  ...m,
  name: `${m.name}（测试构建）`,
  host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
}));
await bundle({ outdir, sourcemap: true });
await verifyManifestReferences(outdir, manifest);
console.log('[build:e2e] .test-dist/ 完成（仅用于自动化测试，不作为安装交付）');

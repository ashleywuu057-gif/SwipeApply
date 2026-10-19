import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './build-lib.mjs';

for (const dir of ['dist', '.test-dist', 'test-results']) {
  await rm(path.join(ROOT, dir), { recursive: true, force: true });
}
console.log('[clean] 已删除 dist/ .test-dist/ test-results/');

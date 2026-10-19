import { rm, mkdir, readdir, copyFile, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function cleanDir(dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

async function copyDir(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dest);
    else await copyFile(src, dest);
  }
}

/** Bundle entry points. Content script is a single IIFE with no imports. */
export async function bundle({ outdir, watch = false, sourcemap = false, minify = false }) {
  const shared = {
    bundle: true,
    target: ['chrome120'],
    logLevel: 'warning',
    legalComments: 'none',
    sourcemap,
    minify,
    define: { 'process.env.NODE_ENV': '"production"' },
  };

  const configs = [
    {
      ...shared,
      entryPoints: [path.join(ROOT, 'src/background/index.ts')],
      outfile: path.join(outdir, 'background.js'),
      format: 'esm',
    },
    {
      ...shared,
      entryPoints: [path.join(ROOT, 'src/content/index.ts')],
      outfile: path.join(outdir, 'content.js'),
      format: 'iife',
      splitting: false,
    },
    {
      ...shared,
      entryPoints: [path.join(ROOT, 'src/ui/popup.ts')],
      outfile: path.join(outdir, 'popup.js'),
      format: 'esm',
    },
    {
      ...shared,
      entryPoints: [path.join(ROOT, 'src/ui/app.ts')],
      outfile: path.join(outdir, 'app.js'),
      format: 'esm',
    },
  ];

  if (watch) {
    for (const config of configs) {
      const ctx = await esbuild.context(config);
      await ctx.watch();
    }
    return;
  }
  await Promise.all(configs.map((config) => esbuild.build(config)));
}

export async function copyPublic(outdir, manifestTransform) {
  await copyDir(path.join(ROOT, 'public'), outdir);
  // 发布包会直接包含 Zod 的打包代码，因此同时分发项目和第三方许可证。
  await Promise.all(
    ['LICENSE', 'THIRD_PARTY_NOTICES.md'].map((file) => copyFile(path.join(ROOT, file), path.join(outdir, file))),
  );
  const manifestPath = path.join(outdir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const finalManifest = manifestTransform ? manifestTransform(manifest) : manifest;
  await writeFile(manifestPath, JSON.stringify(finalManifest, null, 2) + '\n', 'utf8');
  return finalManifest;
}

/** Fail the build when the manifest points at files that were not emitted. */
export async function verifyManifestReferences(outdir, manifest) {
  const referenced = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      if (/\.(js|html|css|png|svg)$/.test(value) && !value.startsWith('http')) referenced.add(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(manifest);

  // HTML pages reference their scripts and stylesheets.
  for (const file of await readdir(outdir)) {
    if (!file.endsWith('.html')) continue;
    const html = await readFile(path.join(outdir, file), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = match[1];
      if (!ref.startsWith('http') && !ref.startsWith('data:')) referenced.add(ref.replace(/^\.\//, ''));
    }
  }

  const missing = [];
  for (const ref of referenced) {
    const target = path.join(outdir, ref.split('#')[0].split('?')[0]);
    if (!existsSync(target)) missing.push(ref);
  }
  if (missing.length > 0) {
    throw new Error(`manifest/HTML 引用的文件不存在: ${missing.join(', ')}`);
  }

  // Guard against secrets or absolute local paths leaking into the bundle.
  for (const file of await readdir(outdir)) {
    if (!file.endsWith('.js')) continue;
    const code = await readFile(path.join(outdir, file), 'utf8');
    if (code.includes(ROOT)) throw new Error(`${file} 含有本机绝对路径`);
  }
}

export async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(p);
    else total += (await stat(p)).size;
  }
  return total;
}

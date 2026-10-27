#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = path.join(ROOT, 'services', 'loom-demo', 'dist');
const ASSETS = path.join(DIST, 'assets');
const REPORT = path.join(ROOT, 'outputs', 'bundle-report.json');

const specifications = [
  { id: 'main-js', pattern: /^index-[^.]+\.js$/, raw: 550_000, gzip: 180_000 },
  { id: 'hero-js', pattern: /^HeroCanvas-[^.]+\.js$/, raw: 1_000_000, gzip: 280_000 },
  { id: 'verifier-wasm', pattern: /^kd_core_wasm_bg-[^.]+\.wasm$/, raw: 800_000, gzip: 300_000 },
  { id: 'css', pattern: /^index-[^.]+\.css$/, raw: 120_000, gzip: 25_000 },
];

const fixedAssets = [
  {
    id: 'sigil-webp',
    file: path.join(DIST, 'sigil', 'no-bg-seal-sigil.webp'),
    raw: 250_000,
  },
  {
    id: 'sigil-png',
    file: path.join(DIST, 'sigil', 'no-bg-seal-sigil.png'),
    raw: 1_900_000,
  },
];

function fail(message) {
  throw new Error(`[bundle-report] ${message}`);
}

async function measure(id, file, budgets) {
  const bytes = await readFile(file);
  const result = {
    id,
    file: path.relative(ROOT, file).replaceAll('\\', '/'),
    raw: bytes.length,
    gzip9: gzipSync(bytes, { level: 9 }).length,
    brotli11: brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
    budgets,
  };
  if (result.raw > budgets.raw) {
    fail(`${id} raw bytes ${result.raw} exceed ${budgets.raw}`);
  }
  if (budgets.gzip != null && result.gzip9 > budgets.gzip) {
    fail(`${id} gzip-9 bytes ${result.gzip9} exceed ${budgets.gzip}`);
  }
  return result;
}

async function main() {
  const names = await readdir(ASSETS);
  const measurements = [];
  for (const spec of specifications) {
    const matches = names.filter((name) => spec.pattern.test(name));
    if (matches.length !== 1) {
      fail(`${spec.id} expected one matching artifact, found ${matches.length}`);
    }
    measurements.push(
      await measure(spec.id, path.join(ASSETS, matches[0]), {
        raw: spec.raw,
        gzip: spec.gzip,
      }),
    );
  }
  for (const spec of fixedAssets) {
    measurements.push(await measure(spec.id, spec.file, { raw: spec.raw }));
  }

  const manifest = JSON.parse(await readFile(path.join(DIST, '.vite', 'manifest.json'), 'utf8'));
  const hero = Object.entries(manifest).find(([key]) => key.endsWith('/HeroCanvas.tsx'));
  const mainEntry = Object.values(manifest).find((entry) => entry.isEntry === true);
  if (!hero || hero[1].isDynamicEntry !== true) {
    fail('HeroCanvas is not recorded as a dynamic entry');
  }
  if (!mainEntry?.dynamicImports?.includes(hero[0])) {
    fail('main entry does not reference HeroCanvas as a dynamic import');
  }
  if (mainEntry.imports?.includes(hero[0])) {
    fail('HeroCanvas is also a static import');
  }

  const report = {
    schema: 'truerolls.bundle-report.v1',
    measurements,
    hero: {
      source: hero[0],
      file: hero[1].file,
      dynamic: true,
      static: false,
    },
  };
  await mkdir(path.dirname(REPORT), { recursive: true });
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('artifact\traw\tgzip-9\tbrotli-11\traw budget\tgzip budget');
  for (const item of measurements) {
    console.log(
      `${item.id}\t${item.raw}\t${item.gzip9}\t${item.brotli11}\t${item.budgets.raw}\t${item.budgets.gzip ?? '-'}`,
    );
  }
  console.log(`[bundle-report] PASS: lazy hero=${hero[1].file}; report=${REPORT}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

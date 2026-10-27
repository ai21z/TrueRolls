import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const REQUIRED_PACKAGE_FILES = [
  'kd_core_wasm.js',
  'kd_core_wasm_bg.wasm',
  'kd_core_wasm.d.ts',
  'kd_core_wasm_bg.wasm.d.ts',
  'package.json',
];

function comparisonKey(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

async function resolvePackageDir(root, requested, label) {
  const absolute = path.resolve(root, requested);
  let canonical;
  try {
    canonical = await realpath(absolute);
  } catch (error) {
    throw new Error(`${label} package directory is not readable: ${absolute} (${error.message})`);
  }

  const details = await stat(canonical);
  if (!details.isDirectory()) {
    throw new Error(`${label} package path is not a directory: ${canonical}`);
  }

  for (const file of REQUIRED_PACKAGE_FILES) {
    const required = path.join(canonical, file);
    try {
      await access(required);
    } catch {
      throw new Error(`${label} package is missing required file: ${required}`);
    }
  }

  return canonical;
}

export async function resolveWasmPackagePair(root, args, logPrefix) {
  const [committedArg = 'packages/kd-core-wasm', rebuiltArg = 'outputs/ci-kd-core-wasm'] = args;
  const committedDir = await resolvePackageDir(root, committedArg, 'committed');
  const rebuiltDir = await resolvePackageDir(root, rebuiltArg, 'rebuilt');

  if (comparisonKey(committedDir) === comparisonKey(rebuiltDir)) {
    throw new Error(`refusing same-path comparison: ${committedDir}`);
  }

  console.log(`[${logPrefix}] committed package: ${committedDir}`);
  console.log(`[${logPrefix}] rebuilt package: ${rebuiltDir}`);
  return { committedDir, rebuiltDir };
}

#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveWasmPackagePair } from './wasm-package-paths.mjs';

const ROOT = process.cwd();

const TEST_KEY_1 = 'IHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY=';
const TEST_KEY_2 = 'QycWCxDM++7wJJeyTQHm3h8dNWxhPllY98M8wkVLFrQ=';

const receiptGoldens = [
  {
    name: 'golden_receipt_01_d20.json',
    key: TEST_KEY_1,
    verdict: 'VALID',
    validDrand: true,
  },
  {
    name: 'golden_receipt_02_d20_tampered_face.json',
    key: TEST_KEY_1,
    verdict: 'INVALID',
  },
  {
    name: 'golden_receipt_03_d20_drand.json',
    key: TEST_KEY_1,
    verdict: 'VALID',
    validDrand: true,
  },
  {
    name: 'golden_receipt_04_d20_drand_tampered_sig.json',
    key: TEST_KEY_1,
    verdict: 'INVALID',
    validDrand: false,
  },
  {
    name: 'golden_receipt_05_d20_test_kid_2.json',
    key: TEST_KEY_2,
    verdict: 'VALID',
  },
];

function fail(message) {
  console.error(`[wasm-receipt-parity] FAIL: ${message}`);
  process.exitCode = 1;
}

function stable(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function assertEqual(label, left, right) {
  if (stable(left) !== stable(right)) {
    fail(`${label} mismatch\ncommitted=${stable(left)}\nrebuilt=${stable(right)}`);
  }
}

function receiptReportCore(report) {
  return {
    verdict: report.verdict,
    valid_signature: report.valid_signature,
    valid_drand: report.valid_drand,
    valid_sampling: report.valid_sampling,
    face_ok: report.face_ok,
    metrics_ok: report.metrics_ok,
    errors: report.errors ?? [],
  };
}

async function loadPackage(dir, tag) {
  const jsPath = path.join(dir, 'kd_core_wasm.js');
  const wasmPath = path.join(dir, 'kd_core_wasm_bg.wasm');
  const href = `${pathToFileURL(jsPath).href}?${tag}=${Date.now()}`;
  const mod = await import(href);
  const wasmBytes = await readFile(wasmPath);
  await mod.default({ module_or_path: wasmBytes });
  return mod;
}

async function loadGolden(name) {
  return readFile(path.join(ROOT, 'goldens', name), 'utf8');
}

let packageDirs;
try {
  packageDirs = await resolveWasmPackagePair(
    ROOT,
    process.argv.slice(2),
    'wasm-receipt-parity',
  );
} catch (error) {
  console.error(`[wasm-receipt-parity] FAIL: ${error.message}`);
  process.exit(1);
}
const { committedDir, rebuiltDir } = packageDirs;

const committed = await loadPackage(committedDir, 'receipt_committed');
const rebuilt = await loadPackage(rebuiltDir, 'receipt_rebuilt');

for (const spec of receiptGoldens) {
  const text = await loadGolden(spec.name);
  const committedReport = receiptReportCore(
    JSON.parse(committed.verifyReceiptJson(text, spec.key)),
  );
  const rebuiltReport = receiptReportCore(JSON.parse(rebuilt.verifyReceiptJson(text, spec.key)));

  assertEqual(`${spec.name} receipt verifier output`, committedReport, rebuiltReport);
  if (committedReport.verdict !== spec.verdict) {
    fail(`${spec.name} expected ${spec.verdict}, got ${committedReport.verdict}`);
  }
  if (typeof spec.validDrand === 'boolean' && committedReport.valid_drand !== spec.validDrand) {
    fail(`${spec.name} expected valid_drand=${spec.validDrand}, got ${committedReport.valid_drand}`);
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(
  `[wasm-receipt-parity] OK: committed and rebuilt WASM receipt verifiers agree on ${receiptGoldens.length} receipt goldens.`,
);

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { demoKeySet } from '../api/keys';
import { PRIMARY_DRAND_RECEIPT } from '../generated/receiptFixtures';
import {
  getKdCoreWasmStatus,
  subscribeKdCoreWasm,
  verifyReceiptWasmWithKeySet,
  type WasmVerifyReport,
} from '../api/wasmEngine';
import { InkFrame } from './system/InkFrame';
import css from './Landing.module.css';

const ROWS: ReadonlyArray<[keyof WasmVerifyReport, string, string]> = [
  ['valid_signature', 'signature', 'Ed25519'],
  ['valid_drand', 'drand', 'BLS quicknet pulse'],
  ['valid_sampling', 'sampling', 'draw_u64 replayed'],
  ['face_ok', 'face', 'recomputed'],
  ['metrics_ok', 'metrics', 'α · KL · EV'],
];

function snapshot() {
  return getKdCoreWasmStatus();
}

/**
 * The landing page's verifier card. It shows the real output of the browser
 * verifier on the bundled sample receipt (signed with the public test key), run
 * here when the engine is ready. Nothing on it is typed by hand.
 */
export function SampleVerdictCard() {
  const engine = useSyncExternalStore(subscribeKdCoreWasm, snapshot, snapshot);
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [report, setReport] = useState<WasmVerifyReport | null>(null);

  // The card is below the fold. Its verification is real work on the main thread,
  // so it runs when the card approaches the viewport, not during page load.
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near || engine !== 'ready' || report) return;
    setReport(verifyReceiptWasmWithKeySet(PRIMARY_DRAND_RECEIPT, JSON.stringify(demoKeySet())));
  }, [near, engine, report]);

  return (
    <InkFrame seed={50} className={css.codeCard}>
      <div className={css.codeHead}>
        <span>bundled sample · public test key</span>
        <span>run in this browser · wasm</span>
      </div>
      <div ref={ref} className={css.codeBody} data-sample-verdict={report?.verdict ?? engine}>
        {report ? (
          <>
            <span className={report.verdict === 'VALID' ? css.codeOk : css.codeFail}>
              {report.verdict}
            </span>
            {'\n'}
            {ROWS.map(([key, label, note]) => {
              const ok = report[key];
              const word = ok === true ? 'pass' : ok === false ? 'FAIL' : 'not run';
              return `  ${label.padEnd(10)} ${word.padEnd(7)} (${note})\n`;
            }).join('')}
            <span className={css.codeNote}>
              This is the sample receipt, not your roll. Check your own on the Verify page.
            </span>
          </>
        ) : engine === 'failed' ? (
          'The verifier engine failed to load in this browser, so the sample was not checked.'
        ) : engine === 'ready' ? (
          'Checking the sample receipt…'
        ) : (
          'Loading the verifier engine…'
        )}
      </div>
    </InkFrame>
  );
}

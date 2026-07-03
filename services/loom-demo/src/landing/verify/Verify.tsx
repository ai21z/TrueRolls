import { useEffect, useRef, useState } from 'react';
import { getApiBaseForCli, getTruerollsKeys, type TruerollsKey } from '../../api/client';
import { DEMO_TEST_KEY, resolveReceiptKey, type KeySource } from '../../api/keys';
import { DRAND_RECEIPT_VERSION, offlineVerifyCommand } from '../../api/receipt';
import { RollSigil } from '../../components/RollSigil';
import { InkFrame } from '../system/InkFrame';
import { InkButton } from '../system/InkButton';
import { SiteSignature } from '../system/SiteSignature';
import {
  initKdCoreWasm,
  isKdCoreWasmReady,
  kdCoreWasmEngineLabel,
  verifyReceiptWasm,
  verifyReceiptWasmWithKeySet,
  type WasmVerifyReport,
} from '../../api/wasmEngine';
import css from './Verify.module.css';

/**
 * Client-side receipt verifier. The entire verdict, Ed25519 signature, DRBG
 * sampling replay, face, and metric caps, is computed in the browser by the
 * shared kd_receipt engine (wasm), the same code `kd verify --receipt` runs.
 * No receipt or key ever leaves the page.
 */

// A signed sample receipt (kd-api ReceiptV2, d20 κ=0.6) so a first-time visitor
// can verify something instantly. It is a verbatim copy of the committed golden
// `goldens/golden_receipt_01_d20.json`, signed by the PUBLIC test key below,
// never a production signer. If the goldens are ever regenerated, this sample
// will visibly verify as INVALID on load (the mount auto-verify is the canary).
// Re-copy the golden when that happens.
const SAMPLE_RECEIPT = `{
  "v": "truerolls-1",
  "id": "00000000-0000-0000-0000-00000000d201",
  "die": "d20",
  "kappa": 0.6,
  "face": 10,
  "alpha": 0.3213648106902838,
  "kl": 0.02011901380257613,
  "ev": 11.65325625845831,
  "created_at": "2026-01-01T00:00:00Z",
  "transcript_url": "/v1/roll/00000000-0000-0000-0000-00000000d201/transcript",
  "proof": {
    "math_param_version": "roll.math.v1",
    "rng": {
      "algo": "HKDF(SHA-256)->ChaCha20Rng",
      "drbg_key_hex": "4242424242424242424242424242424242424242424242424242424242424242"
    },
    "draw_u64": "7618457241228926372"
  },
  "receipt_hash": "sha256:a1dc5db031880eed1b20ef0042dedfae74df895b2bbe88a12a79221413bb350c",
  "sig": {
    "alg": "Ed25519",
    "kid": "test-kid-1",
    "signature_b64": "vsBiCDnNYIx0DduzM/rC3ogH9bOXbqN74khtHPMCvHAGr5/JlwgRjgu8kotUUM8fHSYc2TXue/k+TQqmIEuSDg==",
    "canon": "JCS/RFC8785"
  }
}`;

function receiptHasDrandProof(text: string): boolean {
  try {
    const obj = JSON.parse(text) as { v?: unknown; proof?: { drand?: unknown } };
    // Version-gated, not field-presence: the shared verifier leaves valid_drand
    // true for non-drand versions, so a legacy receipt carrying a stray proof.drand
    // must NOT render a "beacon verified" row.
    return obj.v === DRAND_RECEIPT_VERSION && obj.proof?.drand != null;
  } catch {
    return false;
  }
}

interface CheckRowProps {
  ok: boolean | undefined;
  label: string;
  detail: string;
}

function CheckRow({ ok, label, detail }: CheckRowProps) {
  // Honest tri-state. A check the engine did not report (undefined) is shown as
  // an empty cell / "not run", never as a pass OR a fail. State is carried by the
  // carved cell's fill plus the real checkState word, never a check or cross badge.
  const state = ok === undefined ? 'not run' : ok ? 'pass' : 'fail';
  const stateClass = ok === undefined ? css.checkUnknown : ok ? css.checkPass : css.checkFail;
  return (
    <div className={`${css.checkRow} ${stateClass}`}>
      <span className={css.checkMark} aria-hidden="true" />
      <span className={css.checkLabel}>{label}</span>
      <span className={css.checkDetail}>{detail}</span>
      {/* Real (non-hidden) text so the pass/fail state reaches assistive tech. */}
      <span className={css.checkState}>{state}</span>
    </div>
  );
}

export function Verify() {
  const [receiptText, setReceiptText] = useState<string>(SAMPLE_RECEIPT);
  const [publicKey, setPublicKey] = useState<string>(DEMO_TEST_KEY);
  const [keySource, setKeySource] = useState<KeySource>('demo');
  const [keyKid, setKeyKid] = useState<string | null>('test-kid-1');
  const [keyStatus, setKeyStatus] = useState<string | null>('active');
  const [wellKnownKeys, setWellKnownKeys] = useState<TruerollsKey[]>([]);
  const [report, setReport] = useState<WasmVerifyReport | null>(null);
  const [tampered, setTampered] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const runWithResolved = (text: string, resolved: ReturnType<typeof resolveReceiptKey>) => {
    if (!isKdCoreWasmReady()) {
      setReport({ verdict: 'ERROR', error: 'verifier engine still loading, try again in a moment' });
      return;
    }
    setReport(
      resolved.kind === 'manual'
        ? verifyReceiptWasm(text, resolved.publicKey)
        : verifyReceiptWasmWithKeySet(text, resolved.keySetJson),
    );
  };

  // Resolve the key for `text` against the fetched /.well-known keys, reflect the choice in
  // the key badge, then verify.
  const verify = (text: string) => {
    const r = resolveReceiptKey(text, wellKnownKeys, keySource === 'manual' ? publicKey : null, {
      allowDemoFallback: text === SAMPLE_RECEIPT,
    });
    setPublicKey(r.publicKey);
    setKeySource(r.source);
    setKeyKid(r.kid);
    setKeyStatus(r.status ?? null);
    runWithResolved(text, r);
  };

  // On mount: ensure the wasm engine is up, adopt the site's published key
  // (well-known) or fall back to the demo test key, then verify the sample so
  // the page proves itself on first paint. Awaiting initKdCoreWasm() here (it is
  // idempotent and retries a failed init) avoids a false "engine loading" state
  // on direct navigation or a slow first load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await initKdCoreWasm();
      } catch {
        /* surfaced as an ERROR verdict by runWith if the engine is truly down */
      }
      let keys: TruerollsKey[] = [];
      try {
        keys = (await getTruerollsKeys()).keys;
      } catch {
        /* no live API, the bundled demo key verifies the sample offline */
      }
      if (cancelled) return;
      setWellKnownKeys(keys);
      // Resolve against the just-fetched keys (state isn't committed yet). The sample
      // falls back to the bundled demo key if production does not publish test-kid-1.
      const r = resolveReceiptKey(SAMPLE_RECEIPT, keys, null, { allowDemoFallback: true });
      setPublicKey(r.publicKey);
      setKeySource(r.source);
      setKeyKid(r.kid);
      setKeyStatus(r.status ?? null);
      runWithResolved(SAMPLE_RECEIPT, r);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onVerifyClick = () => verify(receiptText);

  const onReceiptChange = (text: string) => {
    setReceiptText(text);
    setReport(null);
    setTampered(false);
  };

  const onKeyChange = (key: string) => {
    setPublicKey(key);
    setKeySource('manual');
    setKeyKid(null);
    setKeyStatus(null);
    setReport(null);
  };

  const loadSample = () => {
    setReceiptText(SAMPLE_RECEIPT);
    setTampered(false);
    // Resolve the sample against its own signing key, ignoring any prior manual
    // key edit (mirrors the mount canary), so the bundled sample always verifies
    // VALID rather than failing the signature check against a stale manual key.
    const r = resolveReceiptKey(SAMPLE_RECEIPT, wellKnownKeys, null, { allowDemoFallback: true });
    setPublicKey(r.publicKey);
    setKeySource(r.source);
    setKeyKid(r.kid);
    setKeyStatus(r.status ?? null);
    runWithResolved(SAMPLE_RECEIPT, r);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      setReport({ verdict: 'ERROR', error: 'could not read file' });
      return;
    }
    setReceiptText(text);
    setTampered(false);
    verify(text);
  };

  const copy = (text: string, label: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(label);
        setTimeout(() => setCopied(null), 1500);
      })
      .catch(() => {
        /* clipboard blocked, no-op */
      });
  };

  // Edit one field of the receipt JSON in place, re-verify, and watch it break.
  // Surfaces a clear ERROR for input that can't be tampered (non-JSON, non-object,
  // or a missing field) instead of silently doing nothing.
  const tamper = (mutate: (r: Record<string, unknown>) => void) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(receiptText);
    } catch {
      setReport({ verdict: 'ERROR', error: 'receipt is not valid JSON, cannot tamper' });
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setReport({ verdict: 'ERROR', error: 'receipt must be a JSON object, cannot tamper' });
      return;
    }
    const obj = parsed as Record<string, unknown>;
    try {
      mutate(obj);
    } catch (e) {
      setReport({
        verdict: 'ERROR',
        error: e instanceof Error ? e.message : 'cannot tamper this receipt',
      });
      return;
    }
    const next = JSON.stringify(obj, null, 2);
    setReceiptText(next);
    setTampered(true);
    verify(next);
  };

  const tamperFace = () =>
    tamper((r) => {
      if (typeof r.face !== 'number') throw new Error('receipt has no numeric face to flip');
      const sides = typeof r.die === 'string' ? (parseInt(r.die.replace(/\D/g, ''), 10) || 20) : 20;
      r.face = (r.face % sides) + 1;
    });

  const tamperKappa = () =>
    tamper((r) => {
      if (typeof r.kappa !== 'number') throw new Error('receipt has no numeric κ to bump');
      r.kappa = r.kappa === -0.9 ? 0.9 : -0.9;
    });

  // The graph's editable face/κ nodes tamper through the same path as the buttons.
  const onSigilTamper = (field: 'face' | 'kappa', value: number) =>
    tamper((r) => {
      r[field] = value;
    });

  const verdict = report?.verdict;
  const isError = verdict === 'ERROR';
  const isValid = verdict === 'VALID';
  const hasDrandProof = receiptHasDrandProof(receiptText);
  const cliCommand = offlineVerifyCommand(
    receiptText,
    keySource === 'well-known'
      ? { kind: 'server', server: getApiBaseForCli() }
      : { kind: 'public-key', publicKey },
  );

  const keyBadgeText =
    keySource === 'well-known'
      ? `from /.well-known${keyKid ? ` · ${keyKid}` : ''}${keyStatus ? ` · ${keyStatus}` : ''}`
      : keySource === 'demo'
        ? 'demo test key'
        : 'manual';

  return (
    <main className={css.page}>
      <header className={css.bar}>
        <div className={css.barLeft}>
          <a className={css.back} href="#">
            <span className={css.backArrow} aria-hidden="true">←</span>
            Back
          </a>
          <a className={css.brand} href="#" aria-label="TrueRolls home">
            true<span className={css.brandAccent}>rolls</span>
          </a>
        </div>
        <nav className={css.barLinks}>
          <a className={css.barLink} href="#behind-a-roll">
            Behind a roll
          </a>
          <a className={css.barLink} href="#docs">
            Docs
          </a>
          <a className={css.barLink} href="#play">
            Playground
          </a>
        </nav>
      </header>

      <section className={css.intro}>
        <span className={css.eyebrow}>Don't trust. Verify.</span>
        <h1 className={css.title}>Verify a receipt in your browser.</h1>
        <p className={css.lead}>
          Paste or drop a TrueRolls receipt. The Ed25519 signature, the sampling replay, the
          face, and the metric caps are all checked <b>locally</b> by the same engine the CLI
          runs, compiled to WebAssembly. No upload, no account, no server to trust.
        </p>
      </section>

      <div className={css.grid}>
        {/* ── Input ── */}
        <InkFrame seed={21} className={css.panel}>
          <div className={css.panelHead}>
            <span className={css.panelTitle}>Receipt</span>
            <div className={css.panelActions}>
              <InkButton seed={5} className={css.ghostBtn} onClick={loadSample}>
                Load sample
              </InkButton>
              <InkButton seed={6} className={css.ghostBtn} onClick={() => fileRef.current?.click()}>
                Upload .json
              </InkButton>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className={css.fileInput}
                aria-label="Upload receipt JSON file"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
            </div>
          </div>

          <textarea
            className={css.textarea}
            value={receiptText}
            spellCheck={false}
            onChange={(e) => onReceiptChange(e.target.value)}
            aria-label="Receipt JSON"
          />

          <label className={css.keyLabel} htmlFor="pubkey">
            Ed25519 public key (base64)
            <span className={css.keyBadge}>{keyBadgeText}</span>
          </label>
          <input
            id="pubkey"
            className={css.keyInput}
            value={publicKey}
            spellCheck={false}
            onChange={(e) => onKeyChange(e.target.value)}
          />

          <div className={css.runRow}>
            <InkButton seed={7} frameClassName={css.inkAccent} className={css.primaryBtn} onClick={onVerifyClick}>
              Verify in your browser
            </InkButton>
            <div className={css.tamperGroup}>
              <span className={css.tamperHint}>Tamper:</span>
              <InkButton seed={8} frameClassName={css.inkFail} className={css.tamperBtn} onClick={tamperFace}>
                Flip face
              </InkButton>
              <InkButton seed={9} frameClassName={css.inkFail} className={css.tamperBtn} onClick={tamperKappa}>
                Bump κ
              </InkButton>
            </div>
          </div>

          <div className={css.copyRow}>
            <InkButton seed={10} className={css.ghostBtn} onClick={() => copy(receiptText, 'receipt')}>
              {copied === 'receipt' ? 'Copied' : 'Copy receipt'}
            </InkButton>
            <InkButton
              seed={11}
              className={css.ghostBtn}
              onClick={() => copy(cliCommand, 'cmd')}
            >
              {copied === 'cmd' ? 'Copied' : 'Copy CLI command'}
            </InkButton>
            <span className={css.copyHint}>verify the same receipt offline with kd-cli</span>
          </div>
        </InkFrame>

        {/* ── Result ── */}
        <InkFrame seed={37} className={css.panel}>
          <div className={css.panelHead}>
            <span className={css.panelTitle}>Verdict</span>
            <span
              className={css.localBadge}
              title={isKdCoreWasmReady() ? kdCoreWasmEngineLabel() : ''}
            >
              ● verified locally
            </span>
          </div>

          <RollSigil receiptText={receiptText} report={report} editable onTamper={onSigilTamper} />

          <div className={css.result} role="status" aria-live="polite">
            {report === null ? (
              <div className={css.empty}>Verify a receipt to see the result.</div>
            ) : isError ? (
              <div className={`${css.verdict} ${css.verdictError}`}>
                <span className={css.verdictWord}>UNVERIFIABLE</span>
                <span className={css.verdictSub}>{report.error}</span>
              </div>
            ) : (
              <>
                <div className={`${css.verdict} ${isValid ? css.verdictValid : css.verdictInvalid}`}>
                  <span className={css.verdictWord}>{isValid ? 'VALID' : 'INVALID'}</span>
                  <span className={css.verdictSub}>
                    {isValid
                      ? 'VALID proves the roll seed came from a verified public drand beacon when proof.drand is present, and the outcome replays from that seed.'
                      : tampered
                        ? 'Edited. The receipt no longer matches its signature.'
                        : 'One or more checks failed.'}
                  </span>
                </div>

                <div className={css.checks}>
                  <CheckRow
                    ok={report.valid_signature}
                    label="Signature"
                    detail="Ed25519 over the JCS-canonical body"
                  />
                  {hasDrandProof && typeof report.valid_drand === 'boolean' && (
                    <CheckRow
                      ok={report.valid_drand}
                      label="Drand"
                      detail="verified quicknet beacon proof and target binding"
                    />
                  )}
                  <CheckRow
                    ok={report.valid_sampling}
                    label="Seed replay"
                    detail="verified seed → ChaCha20 → draw replayed"
                  />
                  <CheckRow
                    ok={report.face_ok}
                    label="Face"
                    detail="recomputed from the guarded distribution"
                  />
                  <CheckRow
                    ok={report.metrics_ok}
                    label="Metrics"
                    detail="α · KL · EV within caps (tol 1e-9)"
                  />
                </div>

                {report.details && (
                  <dl className={css.details}>
                    <div>
                      <dt>face</dt>
                      <dd>{report.details.recomputed_face}</dd>
                    </div>
                    <div>
                      <dt>α</dt>
                      <dd>{report.details.recomputed_alpha.toFixed(6)}</dd>
                    </div>
                    <div>
                      <dt>KL</dt>
                      <dd>{report.details.recomputed_kl.toFixed(6)}</dd>
                    </div>
                    <div>
                      <dt>EV</dt>
                      <dd>{report.details.recomputed_ev.toFixed(4)}</dd>
                    </div>
                  </dl>
                )}

                {report.errors && report.errors.length > 0 && (
                  <ul className={css.errorList}>
                    {report.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </InkFrame>
      </div>

      <section className={css.honest}>
        <h2 className={css.honestTitle}>What this proves. And what it doesn't.</h2>
        <p>
          A VALID verdict proves the receipt was signed by the holder of the named issuer key, and,
          when <code>proof.drand</code> is present, that the seed came from a verified public drand
          beacon and the outcome replays from it. It does <b>not yet</b> prove the operator could not
          privately discard an unfavourable completed roll and publish only this one. Strict witnessed
          fairness is the v2 protocol, not this per-roll receipt.
        </p>
        <p className={css.honestLinks}>
          <a href="#docs">Read the docs</a> · <a href="#docs-threat-model">the threat model</a>
        </p>
      </section>

      <footer className={css.footer}>
        <SiteSignature />
      </footer>
    </main>
  );
}

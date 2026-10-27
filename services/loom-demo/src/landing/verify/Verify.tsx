import { useEffect, useRef, useState } from 'react';
import { getApiBaseForCli, getTruerollsKeys, type TruerollsKey } from '../../api/client';
import { DEMO_TEST_KEY, resolveReceiptKey, type KeySource } from '../../api/keys';
import { DRAND_RECEIPT_VERSION, offlineVerifyCommand } from '../../api/receipt';
import {
  drandSummaryForReceipt,
  keyTrustExplanation,
  verificationState as deriveVerificationState,
  verificationStateLabel,
  type VerificationPhase,
} from '../../api/trustPresentation';
import {
  LEGACY_RECEIPT,
  PRIMARY_DRAND_RECEIPT,
  TAMPERED_DRAND_RECEIPT,
} from '../../generated/receiptFixtures';
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
 * Client-side receipt verifier. Receipt bytes are checked locally by the shared
 * kd_receipt WASM engine. Automatic issuer-key discovery may fetch the site's
 * published /.well-known key set; the receipt itself is not uploaded by this path.
 */

const SAMPLE_RECEIPT = PRIMARY_DRAND_RECEIPT;

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
  checkId: string;
  ok: boolean | undefined;
  label: string;
  detail: string;
}

function CheckRow({ checkId, ok, label, detail }: CheckRowProps) {
  // Honest tri-state. A check the engine did not report (undefined) is shown as
  // an empty cell / "not run", never as a pass OR a fail. State is carried by the
  // carved cell's fill plus the real checkState word, never a check or cross badge.
  const state = ok === undefined ? 'not run' : ok ? 'pass' : 'fail';
  const stateClass = ok === undefined ? css.checkUnknown : ok ? css.checkPass : css.checkFail;
  return (
    <div className={`${css.checkRow} ${stateClass}`} data-check-id={checkId}>
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
  const [verificationPhase, setVerificationPhase] = useState<VerificationPhase>('loading');
  const [tampered, setTampered] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // True while the on-screen receipt derives from our bundled sample (loaded or
  // tampered). Only in that context do we resolve the PUBLIC demo key for a
  // test-kid-1 receipt, so the sample and its tampered variants can show the
  // signature passing/failing. An arbitrary pasted/uploaded receipt is fail-closed.
  const [sampleContext, setSampleContext] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  const runWithResolved = (text: string, resolved: ReturnType<typeof resolveReceiptKey>) => {
    setVerificationPhase('verifying');
    if (!isKdCoreWasmReady()) {
      setReport({ verdict: 'ERROR', error: 'verifier engine still loading, try again in a moment' });
      setVerificationPhase('complete');
      return;
    }
    const nextReport =
      resolved.kind === 'manual'
        ? verifyReceiptWasm(text, resolved.publicKey)
        : verifyReceiptWasmWithKeySet(text, resolved.keySetJson);
    setReport(nextReport);
    setVerificationPhase('complete');
  };

  // Resolve the key for `text` against the fetched /.well-known keys, reflect the choice in
  // the key badge, then verify.
  const verify = (text: string) => {
    const r = resolveReceiptKey(text, wellKnownKeys, keySource === 'manual' ? publicKey : null, {
      allowDemoFallback: sampleContext,
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
    setVerificationPhase('not_checked');
    setTampered(false);
    // Hand-edited text is no longer the bundled sample: fail closed, no demo key.
    setSampleContext(false);
  };

  const onKeyChange = (key: string) => {
    setPublicKey(key);
    setKeySource('manual');
    setKeyKid(null);
    setKeyStatus(null);
    setReport(null);
    setVerificationPhase('not_checked');
  };

  const loadFixture = (text: string, fixtureTampered: boolean) => {
    setReceiptText(text);
    setTampered(fixtureTampered);
    setSampleContext(true);
    const r = resolveReceiptKey(text, wellKnownKeys, null, { allowDemoFallback: true });
    setPublicKey(r.publicKey);
    setKeySource(r.source);
    setKeyKid(r.kid);
    setKeyStatus(r.status ?? null);
    runWithResolved(text, r);
  };

  const loadSample = () => loadFixture(SAMPLE_RECEIPT, false);
  const loadLegacyControl = () => loadFixture(LEGACY_RECEIPT, false);
  const loadTamperedControl = () => loadFixture(TAMPERED_DRAND_RECEIPT, true);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      setReport({ verdict: 'ERROR', error: 'could not read file' });
      setVerificationPhase('complete');
      return;
    }
    setReceiptText(text);
    setTampered(false);
    setSampleContext(false);
    // Re-resolve against the uploaded receipt's own kid, ignoring any prior
    // manual key so a genuinely issuer-signed upload is not checked against a
    // stale pasted key (which would report a false INVALID).
    const r = resolveReceiptKey(text, wellKnownKeys, null, { allowDemoFallback: false });
    setPublicKey(r.publicKey);
    setKeySource(r.source);
    setKeyKid(r.kid);
    setKeyStatus(r.status ?? null);
    runWithResolved(text, r);
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
      setVerificationPhase('complete');
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setReport({ verdict: 'ERROR', error: 'receipt must be a JSON object, cannot tamper' });
      setVerificationPhase('complete');
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
      setVerificationPhase('complete');
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

  const presentationState = deriveVerificationState({
    phase: verificationPhase,
    report,
    keySource,
  });
  const isValid = presentationState === 'valid';
  const hasDrandProof = receiptHasDrandProof(receiptText);
  const noTrustRoot = presentationState === 'unverifiable' && keySource === 'unresolved';
  let parsedReceiptForSummary: { v?: unknown; proof?: unknown } = {};
  try {
    parsedReceiptForSummary = JSON.parse(receiptText) as { v?: unknown; proof?: unknown };
  } catch {
    parsedReceiptForSummary = {};
  }
  const cliCommand = offlineVerifyCommand(
    receiptText,
    keySource === 'well-known' || keySource === 'unresolved'
      ? { kind: 'server', server: getApiBaseForCli() }
      : { kind: 'public-key', publicKey },
  );

  const keyBadgeText =
    keySource === 'well-known'
      ? `from /.well-known${keyKid ? ` · ${keyKid}` : ''}${keyStatus ? ` · ${keyStatus}` : ''}`
      : keySource === 'demo'
        ? 'public demo key (not issuer-backed)'
        : keySource === 'unresolved'
          ? `no published key for ${keyKid ?? 'this kid'}`
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
          Receipt bytes are checked <b>locally in your browser</b> by the same engine the CLI runs.
          The verifier may fetch the issuer's published key set unless you already pinned or
          supplied the verification key. The receipt itself is not uploaded by this path.
        </p>
      </section>

      <div className={css.grid}>
        {/* ── Input ── */}
        <InkFrame seed={21} className={css.panel}>
          <div className={css.panelHead}>
            <span className={css.panelTitle}>Receipt</span>
            <div className={css.panelActions}>
              <InkButton seed={5} className={css.ghostBtn} onClick={loadSample}>
                Current drand sample
              </InkButton>
              <InkButton seed={12} className={css.ghostBtn} onClick={loadLegacyControl}>
                Legacy control
              </InkButton>
              <InkButton seed={13} className={css.ghostBtn} onClick={loadTamperedControl}>
                Tampered control
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
            <span className={css.keyBadge} data-key-source={keySource}>{keyBadgeText}</span>
            {keySource === 'manual' && (
              <span className={css.keyBypassBadge}>manual key, status bypassed</span>
            )}
          </label>
          <input
            id="pubkey"
            className={css.keyInput}
            value={publicKey}
            spellCheck={false}
            onChange={(e) => onKeyChange(e.target.value)}
          />
          <p className={css.keyTrustNote}>{keyTrustExplanation(keySource)}</p>

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
              title={
                isKdCoreWasmReady()
                  ? `${kdCoreWasmEngineLabel()}. Issuer key discovery may use /.well-known.`
                  : 'Issuer key discovery may use /.well-known.'
              }
            >
              ● verified locally
            </span>
          </div>

          <RollSigil receiptText={receiptText} report={report} editable onTamper={onSigilTamper} />

          <div
            className={css.result}
            role="status"
            aria-live="polite"
            data-verification-state={presentationState}
          >
            {presentationState === 'not_checked' ? (
              <div className={css.empty}>Verify a receipt to see the result.</div>
            ) : presentationState === 'loading' || presentationState === 'verifying' ? (
              <div className={`${css.verdict} ${css.verdictError}`}>
                <span className={css.verdictWord}>{verificationStateLabel(presentationState)}</span>
                <span className={css.verdictSub}>
                  {presentationState === 'loading'
                    ? 'Loading the verifier engine and issuer key information.'
                    : 'Recomputing the receipt checks locally.'}
                </span>
              </div>
            ) : presentationState === 'unverifiable' ? (
              <div className={`${css.verdict} ${css.verdictError}`}>
                <span className={css.verdictWord}>UNVERIFIABLE</span>
                <span className={css.verdictSub}>
                  {noTrustRoot
                    ? `No published key matched kid ${keyKid}. Supply the issuer key set or paste the issuer's public key before the signature can be checked.`
                    : report?.error ?? 'The verifier could not compute a meaningful verdict.'}
                </span>
              </div>
            ) : report ? (
              <>
                <div className={`${css.verdict} ${isValid ? css.verdictValid : css.verdictInvalid}`}>
                  <span className={css.verdictWord}>{isValid ? 'VALID' : 'INVALID'}</span>
                  <span className={css.verdictSub}>
                    {presentationState === 'valid'
                      ? drandSummaryForReceipt(parsedReceiptForSummary)
                      : tampered
                          ? 'Edited. The receipt no longer matches its signature.'
                          : 'One or more checks failed.'}
                  </span>
                </div>

                <div className={css.checks}>
                  <CheckRow
                    checkId="signature"
                    ok={report.valid_signature}
                    label="Signature"
                    detail="Ed25519 over the JCS-canonical body"
                  />
                  {hasDrandProof && typeof report.valid_drand === 'boolean' && (
                    <CheckRow
                      checkId="drand"
                      ok={report.valid_drand}
                      label="Drand"
                      detail="verified quicknet beacon proof and target binding"
                    />
                  )}
                  <CheckRow
                    checkId="sampling"
                    ok={report.valid_sampling}
                    label="Seed replay"
                    detail="verified seed → ChaCha20 → draw replayed"
                  />
                  <CheckRow
                    checkId="face"
                    ok={report.face_ok}
                    label="Face"
                    detail="recomputed from the guarded distribution"
                  />
                  <CheckRow
                    checkId="metrics"
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
            ) : (
              <div className={`${css.verdict} ${css.verdictError}`}>
                <span className={css.verdictWord}>UNVERIFIABLE</span>
                <span className={css.verdictSub}>No verifier report was produced.</span>
              </div>
            )}
          </div>
        </InkFrame>
      </div>

      <section className={css.honest}>
        <h2 className={css.honestTitle}>What this proves. And what it doesn't.</h2>
        <p>
          A VALID verdict proves the receipt was signed by the holder of the named issuer key, and,
          for <code>truerolls-drand-1</code>, that the seed came from a verified public drand
          beacon and the outcome replays from it. For legacy <code>truerolls-1</code>, VALID proves
          signed replay and bounded math only. It does <b>not yet</b> prove the operator could not
          privately discard an unfavourable completed roll and publish only this one. Strict witnessed
          fairness is the v2 protocol, not this per-roll receipt.
        </p>
        <p>
          A published issuer key authenticates the named issuer. It does not remove issuer trust.
          Pasting a manual key bypasses the issuer's published key-status semantics.
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

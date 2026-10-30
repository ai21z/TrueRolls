import { useEffect, useRef, useState } from 'react';
import { getApiBaseForCli } from '../../api/client';
import { DEMO_TEST_KEY } from '../../api/keys';
import { DRAND_RECEIPT_VERSION, offlineVerifyCommand } from '../../api/receipt';
import { consumeReceiptHandoff, peekReceiptHandoff, type HandoffRead } from '../../api/receiptHandoff';
import {
  drandSummaryForReceipt,
  invalidSummary,
  keyTrustExplanation,
  verificationState as deriveVerificationState,
  verificationStateLabel,
} from '../../api/trustPresentation';
import {
  LEGACY_RECEIPT,
  PRIMARY_DRAND_RECEIPT,
  TAMPERED_DRAND_RECEIPT,
} from '../../generated/receiptFixtures';
import {
  presentableReport,
  useReceiptVerification,
  type ReceiptArtifact,
} from '../../hooks/useReceiptVerification';
import { RollSigil } from '../../components/RollSigil';
import { InkFrame } from '../system/InkFrame';
import { InkButton } from '../system/InkButton';
import { SiteSignature } from '../system/SiteSignature';
import { kdCoreWasmEngineLabel } from '../../api/wasmEngine';
import css from './Verify.module.css';

/**
 * Client-side receipt verifier. Receipt bytes are checked locally by the shared
 * kd_receipt WASM engine. Automatic issuer-key discovery may fetch the site's
 * published /.well-known key set; the receipt itself is not uploaded by this path.
 */

const SAMPLES = {
  drand: { text: PRIMARY_DRAND_RECEIPT, label: 'Bundled drand sample' },
  legacy: { text: LEGACY_RECEIPT, label: 'Bundled legacy control' },
  tampered: { text: TAMPERED_DRAND_RECEIPT, label: 'Bundled invalid-drand control' },
} as const;

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

function parsedOrEmpty(text: string): { v?: unknown; proof?: unknown } {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as { v?: unknown; proof?: unknown })
      : {};
  } catch {
    return {};
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
  // an empty cell / "not run", never as a pass OR a fail. The state word is real
  // visible text, so it reaches assistive tech and does not depend on colour.
  const state = ok === undefined ? 'not run' : ok ? 'pass' : 'fail';
  const stateClass = ok === undefined ? css.checkUnknown : ok ? css.checkPass : css.checkFail;
  return (
    <div className={`${css.checkRow} ${stateClass}`} data-check-id={checkId} data-check-state={state}>
      <span className={css.checkMark} aria-hidden="true" />
      <span className={css.checkLabel}>{label}</span>
      <span className={css.checkDetail}>{detail}</span>
      <span className={css.checkState}>{state}</span>
    </div>
  );
}

/** What the page starts with: a receipt handed off from this tab's playground, or nothing. */
function initialFromHandoff(read: HandoffRead): ReceiptArtifact {
  if (read.status === 'ok') {
    return {
      text: read.handoff.receiptJson,
      origin: 'handoff',
      label:
        read.handoff.kind === 'edited-copy'
          ? `Edited copy of roll ${read.handoff.rollId?.slice(0, 8) ?? ''}, not the original`
          : `Your receipt, roll ${read.handoff.rollId?.slice(0, 8) ?? ''}`,
    };
  }
  return { text: '', origin: 'user', label: null };
}

export function Verify() {
  const [handoffRead] = useState<HandoffRead>(() => peekReceiptHandoff());
  const [initial] = useState<ReceiptArtifact>(() => initialFromHandoff(handoffRead));
  const v = useReceiptVerification({
    initial,
    verifyInitial: handoffRead.status === 'ok',
    editsKeepSampleOrigin: false,
  });
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // True only after the user edited a bundled sample in place (Flip face, Bump κ).
  const [sampleEdited, setSampleEdited] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Consume exactly the hand-off this mount read. A newer one is left in place.
  useEffect(() => {
    if (handoffRead.status === 'ok') consumeReceiptHandoff(handoffRead.handoff.token);
    else if (handoffRead.status !== 'none') consumeReceiptHandoff(handoffRead.token);
  }, [handoffRead]);

  const receiptText = v.artifact.text;
  const isSampleOrigin = v.artifact.origin === 'sample';

  const loadSample = (key: keyof typeof SAMPLES) => {
    const sample = SAMPLES[key];
    setActionError(null);
    setSampleEdited(false);
    v.loadArtifact(
      { text: sample.text, origin: 'sample', label: sample.label },
      { verify: true, keepManualKey: false },
    );
  };

  const onReceiptChange = (text: string) => {
    setActionError(null);
    setSampleEdited(false);
    v.editText(text);
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    setActionError(null);
    setSampleEdited(false);
    void v.loadFile(file);
  };

  const copy = (text: string, label: string) => {
    setCopyError(null);
    if (!navigator.clipboard) {
      setCopyError('Copy is blocked in this browser. Select the text and copy it manually.');
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(label);
        setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
      })
      .catch(() => {
        setCopyError('Copy failed. Select the text and copy it manually.');
      });
  };

  // Edit one field of the receipt JSON in place and verify the edited bytes.
  // Input that cannot be edited this way gets an explicit reason, not silence.
  const tamper = (mutate: (r: Record<string, unknown>) => void) => {
    setActionError(null);
    if (!v.diagnosis.ok) {
      setActionError(`Cannot edit a field: ${v.diagnosis.message}`);
      return;
    }
    const obj = JSON.parse(receiptText) as Record<string, unknown>;
    try {
      mutate(obj);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Cannot edit this receipt.');
      return;
    }
    const next = JSON.stringify(obj, null, 2);
    setSampleEdited(isSampleOrigin);
    v.loadArtifact(
      {
        text: next,
        origin: isSampleOrigin ? 'sample' : 'user',
        label: v.artifact.label ? `${v.artifact.label}, edited` : 'Edited receipt',
      },
      { verify: true, keepManualKey: true },
    );
  };

  const tamperFace = () =>
    tamper((r) => {
      if (typeof r.face !== 'number') throw new Error('This receipt has no numeric face to flip.');
      const sides = typeof r.die === 'string' ? (parseInt(r.die.replace(/\D/g, ''), 10) || 20) : 20;
      r.face = (r.face % sides) + 1;
    });

  const tamperKappa = () =>
    tamper((r) => {
      if (typeof r.kappa !== 'number') throw new Error('This receipt has no numeric κ to bump.');
      r.kappa = r.kappa === -0.9 ? 0.9 : -0.9;
    });

  // The graph's editable face/κ nodes tamper through the same path as the buttons.
  const onSigilTamper = (field: 'face' | 'kappa', value: number) =>
    tamper((r) => {
      r[field] = value;
    });

  const bound = v.bound;
  const report = presentableReport(bound);
  const keySource = v.resolved.source;
  const presentationState = deriveVerificationState({
    phase: v.phase,
    report,
    keySource: bound?.resolved.source ?? keySource,
  });
  const isValid = presentationState === 'valid';
  const hasDrandProof = receiptHasDrandProof(receiptText);
  const parsedReceipt = parsedOrEmpty(receiptText);
  const discoveryUnavailable = v.discovery.status === 'unavailable';
  const keyPending = !v.manual && v.discovery.status === 'loading';
  const shownKey = v.manualKey ?? (keyPending ? '' : v.resolved.publicKey);
  const isPublicTestKey = !keyPending && shownKey === DEMO_TEST_KEY;
  const cliCommand = offlineVerifyCommand(
    receiptText,
    keySource === 'well-known' || keySource === 'unresolved'
      ? { kind: 'server', server: getApiBaseForCli() }
      : { kind: 'public-key', publicKey: shownKey },
  );

  const keyBadgeText = v.manual
    ? 'manual key'
    : keyPending
      ? 'looking up the issuer key…'
      : keySource === 'well-known'
        ? `issuer key · ${v.resolved.kid ?? ''}${v.resolved.status ? ` · ${v.resolved.status}` : ''}`
        : keySource === 'demo'
          ? 'public test key · samples only'
          : discoveryUnavailable
            ? 'issuer key set unavailable'
            : `no published key for ${v.resolved.kid ?? 'this receipt'}`;

  let unverifiableText = 'The verifier could not compute a meaningful verdict.';
  if (bound?.inputProblem) unverifiableText = bound.inputProblem.message;
  else if (bound?.engineFailed) unverifiableText = bound.report.error ?? unverifiableText;
  else if (bound && bound.resolved.source === 'unresolved') {
    unverifiableText =
      v.discovery.status === 'unavailable'
        ? `${v.discovery.reason} The signature was not checked. Retry the lookup, or paste the issuer's public key.`
        : `No published key matches kid ${bound.resolved.kid ?? '(none)'}. The signature was not checked. Paste the issuer's public key to check it.`;
  } else if (report?.error) unverifiableText = report.error;

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

      {(handoffRead.status === 'expired' || handoffRead.status === 'malformed') && (
        <p className={css.handoffNotice} role="note">
          {handoffRead.status === 'expired'
            ? 'The receipt sent from the playground expired before this page opened. Copy or download it from the playground and paste it here.'
            : 'The receipt sent from the playground could not be read. Copy or download it from the playground and paste it here.'}
        </p>
      )}

      <div className={css.grid}>
        {/* ── Input ── */}
        <InkFrame seed={21} className={css.panel}>
          <div className={css.panelHead}>
            <span className={css.panelTitle}>Receipt</span>
            <div className={css.panelActions}>
              <InkButton seed={6} className={css.ghostBtn} onClick={() => fileRef.current?.click()}>
                Upload .json
              </InkButton>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className={css.fileInput}
                aria-label="Upload receipt JSON file"
                onChange={(e) => {
                  onFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
          </div>

          <div className={css.sampleRow} role="group" aria-label="Bundled samples">
            <span className={css.sampleHint}>Samples, signed with the public test key:</span>
            <InkButton seed={5} className={css.ghostBtn} onClick={() => loadSample('drand')}>
              Current drand sample
            </InkButton>
            <InkButton seed={12} className={css.ghostBtn} onClick={() => loadSample('legacy')}>
              Legacy control
            </InkButton>
            <InkButton seed={13} className={css.ghostBtn} onClick={() => loadSample('tampered')}>
              Tampered control
            </InkButton>
          </div>

          <p className={css.artifactLabel} data-artifact-origin={v.artifact.origin}>
            {v.artifact.label ?? (receiptText.trim() === '' ? 'Nothing loaded yet.' : 'Pasted receipt')}
          </p>

          <textarea
            className={css.textarea}
            value={receiptText}
            spellCheck={false}
            placeholder="Paste a TrueRolls receipt (JSON) here."
            onChange={(e) => onReceiptChange(e.target.value)}
            aria-label="Receipt JSON"
          />
          {v.fileError && (
            <p className={css.inlineError} role="alert">
              {v.fileError}
            </p>
          )}
          {v.fileNotice && (
            <p className={css.inlineNotice} role="status">
              {v.fileNotice}
            </p>
          )}

          <label className={css.keyLabel} htmlFor="pubkey">
            Ed25519 public key (base64)
            <span className={css.keyBadge} data-key-source={v.manual ? 'manual' : keyPending ? 'pending' : keySource}>
              {keyBadgeText}
            </span>
            {isPublicTestKey && !v.manual && keySource === 'well-known' && (
              <span className={css.keyBadge} data-key-test="public">public test key</span>
            )}
            {v.manual && <span className={css.keyBypassBadge}>manual key, status bypassed</span>}
          </label>
          <input
            id="pubkey"
            className={css.keyInput}
            value={shownKey}
            spellCheck={false}
            placeholder={keyPending ? 'Looking up the issuer key…' : 'Resolved from the issuer key set, or paste a key'}
            onChange={(e) => v.setManualKey(e.target.value)}
          />
          <p className={css.keyTrustNote}>
            {keyPending
              ? 'Looking up the issuer key set. You can paste a key instead.'
              : v.discovery.status === 'unavailable' && !v.manual && keySource === 'unresolved'
                ? v.discovery.reason
                : keyTrustExplanation(v.manual ? 'manual' : keySource)}
            {v.manual && (
              <>
                {' '}
                <button type="button" className={css.linkBtn} onClick={v.clearManualKey}>
                  Use the issuer key instead
                </button>
              </>
            )}
            {discoveryUnavailable && !v.manual && (
              <>
                {' '}
                <button type="button" className={css.linkBtn} onClick={v.retryKeyDiscovery}>
                  Retry key lookup
                </button>
              </>
            )}
          </p>

          <div className={css.runRow}>
            <InkButton seed={7} frameClassName={css.inkAccent} className={css.primaryBtn} onClick={v.verify}>
              Verify in your browser
            </InkButton>
            <div className={css.tamperGroup}>
              <span className={css.tamperHint}>Edit a signed value:</span>
              <InkButton seed={8} frameClassName={css.inkFail} className={css.tamperBtn} onClick={tamperFace}>
                Flip face
              </InkButton>
              <InkButton seed={9} frameClassName={css.inkFail} className={css.tamperBtn} onClick={tamperKappa}>
                Bump κ
              </InkButton>
            </div>
          </div>
          {actionError && (
            <p className={css.inlineError} role="alert">
              {actionError}
            </p>
          )}

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
          <p className={css.srOnly} role="status" aria-live="polite">
            {copyError ?? (copied ? 'Copied to the clipboard.' : '')}
          </p>
          {copyError && <p className={css.inlineError}>{copyError}</p>}
        </InkFrame>

        {/* ── Result ── */}
        <InkFrame seed={37} className={css.panel}>
          <div className={css.panelHead}>
            <h2 className={css.panelTitle}>Verdict</h2>
            <span
              className={css.localBadge}
              title={
                v.engine === 'ready'
                  ? `${kdCoreWasmEngineLabel()}. Issuer key discovery may use /.well-known.`
                  : 'Issuer key discovery may use /.well-known.'
              }
            >
              {v.engine === 'failed' ? 'Engine failed to load' : 'Runs locally'}
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
              <div className={css.empty}>
                {receiptText.trim() === ''
                  ? 'NOT CHECKED. Paste or upload a receipt, or load a sample.'
                  : 'NOT CHECKED. Verify this receipt to see the result.'}
              </div>
            ) : presentationState === 'loading' || presentationState === 'verifying' ? (
              <div className={`${css.verdict} ${css.verdictError}`}>
                <span className={css.verdictWord}>{verificationStateLabel(presentationState)}</span>
                <span className={css.verdictSub}>
                  {presentationState === 'loading'
                    ? v.engine !== 'ready'
                      ? 'Loading the verifier engine.'
                      : 'Looking up the issuer key set.'
                    : 'Recomputing the receipt checks locally.'}
                </span>
              </div>
            ) : presentationState === 'unverifiable' ? (
              <div className={`${css.verdict} ${css.verdictError}`}>
                <span className={css.verdictWord}>UNVERIFIABLE</span>
                <span className={css.verdictSub}>{unverifiableText}</span>
                {bound?.engineFailed && (
                  <button type="button" className={css.linkBtn} onClick={v.retryEngine}>
                    Retry loading the engine
                  </button>
                )}
              </div>
            ) : report ? (
              <>
                <div className={`${css.verdict} ${isValid ? css.verdictValid : css.verdictInvalid}`}>
                  <span className={css.verdictWord}>{isValid ? 'VALID' : 'INVALID'}</span>
                  <span className={css.verdictSub}>
                    {isValid
                      ? drandSummaryForReceipt(parsedReceipt)
                      : invalidSummary(report, parsedReceipt)}
                    {!isValid && sampleEdited && isSampleOrigin
                      ? ' This is an edited sample; the original sample is unchanged.'
                      : ''}
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

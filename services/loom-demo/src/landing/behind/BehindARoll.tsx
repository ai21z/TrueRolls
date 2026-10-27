import { useEffect, useMemo, useRef, useState } from 'react';
import { getTruerollsKeys, type TruerollsKey } from '../../api/client';
import { DEMO_TEST_KEY, resolveReceiptKey, type KeySource } from '../../api/keys';
import { InkFrame } from '../system/InkFrame';
import { InkButton } from '../system/InkButton';
import { SiteSignature } from '../system/SiteSignature';
import { CeremonyRail } from './CeremonyRail';
import { ContactSheet } from './ContactSheet';
import { KappaBaseline } from './KappaBaseline';
import { asRecord, hasBeacon, isLegacyReceipt, proofScope, readField, shorten } from './receiptFields';
import { PRIMARY_DRAND_RECEIPT } from '../../generated/receiptFixtures';
import {
  keyTrustExplanation,
  verificationState as deriveVerificationState,
  verificationStateLabel,
  type VerificationPhase,
} from '../../api/trustPresentation';
import {
  initKdCoreWasm,
  isKdCoreWasmReady,
  verifyReceiptWasm,
  verifyReceiptWasmWithKeySet,
  type WasmVerifyReport,
} from '../../api/wasmEngine';
import css from './BehindARoll.module.css';

/**
 * Behind a TrueRoll, the Specimen Plate (surface B of the design note
 * docs/design/behind-a-roll.md). The real WASM verifier runs in the browser and
 * its per-check booleans are rendered as a stepped, forensic evidence chain. No
 * server testimony: every stratum's pass/fail comes from the same kd_receipt
 * engine the CLI runs. Version-aware: a legacy truerolls-1 receipt shows the
 * drand stratum as absent, never as if it had a beacon seed.
 */

const SAMPLE_DRAND_RECEIPT = PRIMARY_DRAND_RECEIPT;
type StratumStatus = 'pass' | 'fail' | 'absent' | 'pending';

interface StratumField {
  label: string;
  value: string;
}

interface Stratum {
  key: string;
  name: string;
  tag: string;
  status: StratumStatus;
  fields: StratumField[];
  proves: string;
  limit: string;
}

function parseReceipt(text: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(text) as unknown;
    return o !== null && typeof o === 'object' && !Array.isArray(o)
      ? (o as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function statusFrom(ok: boolean | undefined): StratumStatus {
  return ok === undefined ? 'pending' : ok ? 'pass' : 'fail';
}

/**
 * Map the real verifier report + the receipt's own fields onto the forensic
 * strata. Each status comes straight from the engine's per-check booleans. The
 * field values are read verbatim from the receipt. Nothing here re-judges the
 * receipt, it only arranges what the verifier already decided.
 */
function buildStrata(parsed: Record<string, unknown> | null, report: WasmVerifyReport | null): Stratum[] {
  const proof = asRecord(parsed?.proof);
  const rng = asRecord(proof.rng);
  const sig = asRecord(parsed?.sig);
  // Version-gated (NOT field-presence): a legacy receipt with a stray proof.drand
  // block is NOT beacon-backed. The engine never verified it. Mirrors hasBeacon
  // so B's drand stratum can never disagree with A/C. `drand` fields are only read
  // inside the `beacon` branch below. For legacy the absent branch ignores them.
  const beacon = hasBeacon(parsed);
  const legacy = isLegacyReceipt(parsed);
  const drand = asRecord(proof.drand);

  const strata: Stratum[] = [
    {
      key: 'signature',
      name: 'Signature',
      tag: 'Seal',
      status: statusFrom(report?.valid_signature),
      fields: [
        { label: 'sig.kid', value: readField(sig, 'kid') || '-' },
        { label: 'receipt_hash', value: shorten(readField(parsed ?? {}, 'receipt_hash')) || '-' },
      ],
      proves:
        'The body, canonicalised (JCS / RFC 8785), is checked against the Ed25519 public key shown below. Any signed-value edit cracks the seal.',
      limit: 'Proves integrity and who signed, not when it was signed.',
    },
  ];

  if (beacon) {
    strata.push({
      key: 'drand',
      name: 'Drand beacon',
      tag: 'Provenance',
      status: statusFrom(report?.valid_drand),
      fields: [
        { label: 'target_round', value: readField(drand, 'target_round') || '-' },
        { label: 'observed_round', value: readField(drand, 'client_observed_round') || '-' },
        { label: 'chain', value: shorten(readField(drand, 'chain_hash')) || '-' },
      ],
      proves:
        'Both the observed and target pulses must BLS-verify against the pinned quicknet key, with randomness = SHA256 of the verified signature.',
      limit:
        'Proves the seed came from a public future beacon, not that the operator could not refuse or suppress a completed roll.',
    });
  } else {
    strata.push({
      key: 'drand',
      name: 'Drand beacon',
      tag: 'Absent',
      status: 'absent',
      fields: [{ label: 'proof.drand', value: 'not present' }],
      proves: legacy
        ? 'This is a legacy truerolls-1 receipt: signature and replay only, with no public-beacon seed provenance.'
        : 'No drand beacon is present in this receipt.',
      limit: legacy
        ? 'No drand provenance. Read it as signed and replayable, not beacon-backed.'
        : 'No drand provenance. This receipt is not beacon-backed.',
    });
  }

  strata.push(
    {
      key: 'seed',
      name: 'Seed and draw',
      tag: 'Replay',
      status: statusFrom(report?.valid_sampling),
      fields: [
        { label: 'drbg_key_hex', value: shorten(readField(rng, 'drbg_key_hex')) || '-' },
        { label: 'draw_u64', value: readField(proof, 'draw_u64') || '-' },
      ],
      proves: beacon
        ? 'HKDF re-derives the seed from the pulse and ChaCha20 replays the draw, it must match the receipt bit for bit.'
        : 'The published seed re-seeds ChaCha20 to replay the draw, it must match the receipt bit for bit.',
      limit: 'A pure function of public inputs, which is why you can redo it yourself.',
    },
    {
      key: 'face',
      name: 'Outcome',
      tag: 'Face',
      status: statusFrom(report?.face_ok),
      fields: [
        { label: 'face', value: readField(parsed ?? {}, 'face') || '-' },
        ...(report?.details
          ? [{ label: 'recomputed', value: String(report.details.recomputed_face) }]
          : []),
      ],
      proves:
        'kd-core rebuilds the guarded distribution from die and κ. The recomputed face must match the receipt. Prefix-CDF, no modulo bias.',
      limit:
        'κ is a signed input to both the seed and the distribution, bounded by the KL/EV caps and recomputed here, never a hidden nudge.',
    },
    {
      key: 'metrics',
      name: 'Metrics',
      tag: 'Caps',
      status: statusFrom(report?.metrics_ok),
      fields: [
        { label: 'α', value: readField(parsed ?? {}, 'alpha') || '-' },
        { label: 'KL', value: readField(parsed ?? {}, 'kl') || '-' },
        { label: 'EV', value: readField(parsed ?? {}, 'ev') || '-' },
      ],
      proves: 'α, KL and EV are recomputed and must fall within the caps (tolerance 1e-9).',
      limit: 'The bound is enforced and public. The stance is visible, not hidden.',
    },
  );

  return strata;
}

const STATE_WORD: Record<StratumStatus, string> = {
  pass: 'sealed',
  fail: 'severed',
  absent: 'absent',
  pending: 'pending',
};
const STATE_CLASS: Record<StratumStatus, string> = {
  pass: 'sealed',
  fail: 'severed',
  absent: 'absent',
  pending: 'pending',
};

// "sealed" is reserved for the literal Ed25519 seal (the Signature stratum). The
// other strata are recomputations, so a held recomputation reads "holds", not
// "sealed". The word must not imply a stronger guarantee than a re-derivation
// that matched. The carved-cell fill (STATE_CLASS) stays the same green either way.
function stateWord(status: StratumStatus, key: string): string {
  if (status === 'pass') return key === 'signature' ? 'sealed' : 'holds';
  return STATE_WORD[status];
}

// Short labels for the compact custody index (surface C).
const SHORT_LABEL: Record<string, string> = {
  signature: 'Signature',
  drand: 'Drand',
  seed: 'Seed',
  face: 'Outcome',
  metrics: 'Metrics',
};

// 'smooth' unless the user prefers reduced motion. CSS reduced-motion does not
// override a JS behavior:'smooth' (WCAG 2.3.3 / honoring the OS setting).
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

export function BehindARoll() {
  const [receiptText, setReceiptText] = useState<string>(SAMPLE_DRAND_RECEIPT);
  const [publicKey, setPublicKey] = useState<string>(DEMO_TEST_KEY);
  const [keyEdited, setKeyEdited] = useState<boolean>(false);
  const [keySource, setKeySource] = useState<KeySource>('demo');
  const [keyKid, setKeyKid] = useState<string | null>('test-kid-1');
  // See Verify.tsx: only the bundled sample (loaded or edited in place) resolves
  // the PUBLIC demo key; an arbitrary pasted/uploaded receipt is fail-closed.
  const [sampleContext, setSampleContext] = useState(true);
  const [report, setReport] = useState<WasmVerifyReport | null>(null);
  const [verificationPhase, setVerificationPhase] = useState<VerificationPhase>('loading');
  const [wellKnownKeys, setWellKnownKeys] = useState<TruerollsKey[]>([]);
  const [active, setActive] = useState<number>(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const bandRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const parsed = useMemo(() => parseReceipt(receiptText), [receiptText]);
  const strata = useMemo(() => buildStrata(parsed, report), [parsed, report]);
  const cells = strata.map((s) => ({
    key: s.key,
    label: SHORT_LABEL[s.key] ?? s.name,
    status: s.status,
    word: stateWord(s.status, s.key),
  }));
  const scrollToPlate = () => {
    document
      .getElementById('specimen-plate')
      ?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
    // Move keyboard focus to the plate so the rail's "re-examine" hand-off does
    // not strand the user back at the rail (WCAG 2.4.3 focus order).
    window.setTimeout(() => bandRefs.current[active]?.focus({ preventScroll: true }), 0);
  };

  const runWithResolved = (text: string, resolved: ReturnType<typeof resolveReceiptKey>) => {
    // Reflect the resolved key provenance immediately, BEFORE the engine-readiness
    // early return, so the badge and key input can never desync from the last
    // resolution (e.g. a slow first wasm load leaving stale mount defaults).
    setKeySource(resolved.source);
    setKeyKid(resolved.kid);
    setActive(0);
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

  const verify = (
    text: string,
    edited: boolean = keyEdited,
    allowDemoFallback: boolean = sampleContext,
  ) => {
    // A key the user typed wins as-is, otherwise resolve well-known/demo by kid.
    // `edited` is threaded explicitly so loadSample/onFile can force a re-resolve
    // without waiting on the async keyEdited state update.
    const resolved = resolveReceiptKey(text, wellKnownKeys, edited ? publicKey : null, {
      allowDemoFallback,
    });
    setPublicKey(resolved.publicKey);
    runWithResolved(text, resolved);
  };

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
      const resolved = resolveReceiptKey(SAMPLE_DRAND_RECEIPT, keys, null, {
        allowDemoFallback: true,
      });
      setPublicKey(resolved.publicKey);
      runWithResolved(SAMPLE_DRAND_RECEIPT, resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onReceiptChange = (text: string) => {
    setReceiptText(text);
    setReport(null);
    setVerificationPhase('not_checked');
    // Editing the textarea here IS the tamper action (there are no separate
    // tamper buttons), so a loaded sample stays in sample-context and shows its
    // signature breaking via the demo key. Only load-sample / upload change it.
  };

  const loadSample = () => {
    setReceiptText(SAMPLE_DRAND_RECEIPT);
    setKeyEdited(false);
    setSampleContext(true);
    verify(SAMPLE_DRAND_RECEIPT, false, true);
  };

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
    setKeyEdited(false);
    setSampleContext(false);
    verify(text, false, false);
  };

  const step = (delta: number) => {
    if (strata.length === 0) return;
    setActive((a) => (a + delta + strata.length) % strata.length);
  };

  const presentationState = deriveVerificationState({
    phase: verificationPhase,
    report,
    keySource,
  });
  const isValid = presentationState === 'valid';
  const noTrustRoot = presentationState === 'unverifiable' && keySource === 'unresolved';
  const verdictWord = verificationStateLabel(presentationState);
  const verdictClass =
    presentationState === 'valid'
      ? css.verdictValid
      : presentationState === 'invalid'
        ? css.verdictInvalid
        : css.verdictError;
  const beacon = hasBeacon(parsed);
  // Precise version (NOT just "non-drand"): an unsupported-version or malformed
  // receipt is neither drand nor legacy, and must not be narrated as legacy.
  const isLegacy = isLegacyReceipt(parsed);
  // Version-aware proof scope (null unless VALID): one source of truth shared by
  // the B pill, the C pill, and the closing prose so they can never disagree.
  const scopeText = proofScope(parsed, report);
  // Artifact vs key provenance are distinct: the bundled sample is the committed
  // golden text. A manually typed demo key can still verify other receipts, so
  // the badge must not call those a "bundled sample".
  const isSample = receiptText === SAMPLE_DRAND_RECEIPT;
  const isDemoKey = publicKey === DEMO_TEST_KEY;
  const dieVal = parsed?.die;
  const kappaRaw = parsed?.kappa;
  const die = typeof dieVal === 'string' ? dieVal : '';
  const kappaNum = typeof kappaRaw === 'number' ? kappaRaw : NaN;

  return (
    <main className={css.page}>
      <header className={css.bar}>
        <div className={css.barLeft}>
          <a className={css.back} href="#">
            <span className={css.backArrow} aria-hidden="true">
              ←
            </span>
            Back
          </a>
          <a className={css.brand} href="#" aria-label="TrueRolls home">
            true<span className={css.brandAccent}>rolls</span>
          </a>
        </div>
        <nav className={css.barLinks}>
          <a className={css.barLink} href="#verify">
            Verify
          </a>
          <a className={css.barLink} href="#docs">
            Docs
          </a>
        </nav>
      </header>

      <section className={css.intro}>
        <span className={css.eyebrow}>Behind a TrueRoll</span>
        <h1 className={css.title}>Read a roll under glass.</h1>
        <p className={css.lead}>
          Receipt bytes are checked <b>locally in your browser</b> by the same engine the CLI runs.
          The verifier may fetch the issuer's published key set unless you supplied the key. The
          receipt itself is not uploaded by this browser-verifier path.
        </p>
      </section>

      <div className={css.standing} role="note">
        <span className={css.standingKey}>Standing limit</span>
        <span className={css.standingVal}>
          Proves <b>seed provenance and replay</b>. Does <b>not</b> prove the operator could not
          refuse, time out, or suppress an unfavourable attempt before this receipt existed.
        </span>
      </div>

      <CeremonyRail parsed={parsed} report={report} onReExamine={scrollToPlate} />

      <ContactSheet
        cells={cells}
        active={active}
        verificationState={presentationState}
        scope={scopeText}
        onSelect={(i) => {
          setActive(i);
          // setTimeout (not rAF) so focus still lands after the re-render even when
          // the tab is backgrounded, where requestAnimationFrame is paused.
          window.setTimeout(() => {
            const el = bandRefs.current[i];
            el?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
            el?.focus({ preventScroll: true });
          }, 0);
        }}
      />

      <div className={css.grid}>
        {/* Source */}
        <InkFrame seed={23} className={css.panel}>
          <div className={css.panelHead}>
            <span className={css.panelTitle}>Specimen</span>
            <div className={css.panelActions}>
              <InkButton seed={5} className={css.ghostBtn} onClick={loadSample}>
                Load drand sample
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

          {(isSample || isDemoKey) && (
            <p className={css.testKeyBadge} role="note">
              {isSample
                ? '● bundled sample · public test key, demo only, not production evidence'
                : '● public test key, not production evidence (the key in use is the demo key)'}
            </p>
          )}

          <textarea
            className={css.textarea}
            value={receiptText}
            spellCheck={false}
            onChange={(e) => onReceiptChange(e.target.value)}
            aria-label="Receipt JSON"
          />

          <label className={css.keyLabel} htmlFor="pubkey">
            Ed25519 public key (base64)
            {keySource === 'manual' && (
              <span className={css.keyBypassBadge}>manual key, status bypassed</span>
            )}
          </label>
          <input
            id="pubkey"
            className={css.keyInput}
            value={publicKey}
            spellCheck={false}
            onChange={(e) => {
              setPublicKey(e.target.value);
              setKeyEdited(true);
              setKeySource('manual');
              setKeyKid(null);
              setReport(null);
              setVerificationPhase('not_checked');
            }}
          />
          <p className={css.keyTrustNote}>{keyTrustExplanation(keySource)}</p>

          <div className={css.runRow}>
            <InkButton
              seed={7}
              frameClassName={css.inkAccent}
              className={css.primaryBtn}
              onClick={() => verify(receiptText)}
            >
              Re-examine in your browser
            </InkButton>
          </div>
        </InkFrame>

        {/* Specimen plate */}
        <InkFrame seed={41} id="specimen-plate" className={css.panel}>
          <div className={css.panelHead}>
            <span className={css.panelTitle}>Specimen plate</span>
            <span
              className={css.localBadge}
              title="Local receipt verification. Issuer key discovery may use /.well-known."
            >
              ● recomputed locally
            </span>
          </div>

          <div
            className={`${css.verdict} ${verdictClass}`}
            role="status"
            aria-live="polite"
            data-verification-state={presentationState}
          >
            <span className={css.verdictWord}>{verdictWord}</span>
            {scopeText && <span className={css.verdictScope}>{scopeText}</span>}
            <span className={css.verdictSub}>
              {presentationState === 'loading'
                ? 'Loading the verifier engine and issuer key information.'
                : presentationState === 'verifying'
                  ? 'Recomputing the receipt checks locally.'
                  : presentationState === 'not_checked'
                    ? 'Receipt or key changed. Re-examine to compute a verdict.'
                    : noTrustRoot
                      ? `No published key matched kid ${keyKid}. Supply the issuer key set or paste the issuer's public key before the signature can be checked.`
                      : presentationState === 'unverifiable'
                        ? report?.error ?? 'The verifier could not compute a meaningful verdict.'
                        : isValid
                  ? isLegacy
                    ? 'Signed and replayable. Legacy receipt, no drand provenance.'
                    : 'Signed, drand-seeded, and bit-for-bit replayable.'
                          : 'One or more strata did not hold.'}
            </span>
          </div>

          <div className={css.strata}>
            {strata.map((s, i) => {
              const focused = i === active;
              const stateClass = css[STATE_CLASS[s.status]] ?? '';
              return (
                <button
                  key={s.key}
                  ref={(el) => {
                    bandRefs.current[i] = el;
                  }}
                  type="button"
                  className={`${css.band} ${focused ? css.focus : ''} ${stateClass}`}
                  aria-expanded={focused}
                  aria-controls={`stratum-detail-${s.key}`}
                  onClick={() => setActive(i)}
                >
                  <span className={`${css.assay} ${stateClass}`} aria-hidden="true" />
                  <div className={css.bandMain}>
                    <div className={css.bandTop}>
                      <span className={css.bandName}>{s.name}</span>
                      <span className={css.bandTag}>{s.tag}</span>
                      <span className={css.bandState}>{stateWord(s.status, s.key)}</span>
                    </div>
                    <div className={css.bandFields}>
                      {s.fields.map((f) => (
                        <span key={f.label} className={css.field}>
                          <i className={css.fieldLabel}>{f.label}</i> {f.value}
                        </span>
                      ))}
                    </div>
                    <div className={css.bandDetail} id={`stratum-detail-${s.key}`}>
                      {focused && <p className={css.proves}>{s.proves}</p>}
                      <p className={css.limit}>
                        <span className={css.limitTag}>Limit</span> {s.limit}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className={css.plateCtrls}>
            <InkButton seed={8} className={css.ghostBtn} onClick={() => step(-1)}>
              ▲ Raise
            </InkButton>
            <InkButton seed={9} className={css.ghostBtn} onClick={() => step(1)}>
              ▼ Lower loupe
            </InkButton>
            <span className={css.hint}>
              {strata.length > 0 ? `${active + 1} / ${strata.length}` : '0 / 0'} · click a stratum
            </span>
          </div>

          {report?.errors && report.errors.length > 0 && (
            <ul className={css.errorList}>
              {report.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </InkFrame>
      </div>

      <KappaBaseline die={die} kappa={kappaNum} valid={isValid} beacon={beacon} />

      <section className={css.honest}>
        <h2 className={css.honestTitle}>What a sealed plate proves. And what it doesn't.</h2>
        <p>
          {beacon ? (
            <>
              When every stratum holds, a drand receipt is <b>drand-seeded and bit-for-bit
              replayable</b>. The receipt bytes were checked locally; issuer key discovery may have
              used the published <code>/.well-known</code> key set.
            </>
          ) : isLegacy ? (
            <>
              When every stratum holds, a legacy receipt is <b>signed and bit-for-bit replayable</b>,
              and checked locally. Issuer key discovery may have used the published key set. It carries{' '}
              <b>no public-beacon seed provenance</b>.
            </>
          ) : (
            <>
              When every stratum holds, a receipt is <b>signed and bit-for-bit replayable</b>, and you
              checked locally. Issuer key discovery may have used the published key set.
            </>
          )}{' '}
          It does <b>not</b> prove the operator could not have privately failed an unfavourable attempt
          and published only this one. Strict witnessed fairness is the v2 protocol, not this per-roll
          drand receipt.
        </p>
        <p className={css.honestLinks}>
          <a href="#verify">Verify your own receipt</a> · <a href="#docs">read the docs</a>
        </p>
      </section>

      <footer className={css.footer}>
        <SiteSignature />
      </footer>
    </main>
  );
}

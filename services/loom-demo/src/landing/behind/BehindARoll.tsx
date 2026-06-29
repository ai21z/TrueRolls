import { useEffect, useMemo, useRef, useState } from 'react';
import { getTruerollsKeys, type TruerollsKey } from '../../api/client';
import { InkFrame } from '../system/InkFrame';
import { InkButton } from '../system/InkButton';
import { SiteSignature } from '../system/SiteSignature';
import { CeremonyRail } from './CeremonyRail';
import { ContactSheet } from './ContactSheet';
import {
  initKdCoreWasm,
  isKdCoreWasmReady,
  verifyReceiptWasm,
  type WasmVerifyReport,
} from '../../api/wasmEngine';
import css from './BehindARoll.module.css';

/**
 * Behind a TrueRoll - the Specimen Plate (surface B of the design note
 * docs/design/behind-a-roll.md). The real WASM verifier runs in the browser and
 * its per-check booleans are rendered as a stepped, forensic evidence chain. No
 * server testimony: every stratum's pass/fail comes from the same kd_receipt
 * engine the CLI runs. Version-aware: a legacy truerolls-1 receipt shows the
 * drand stratum as absent, never as if it had a beacon seed.
 */

// Bundled real truerolls-drand-1 sample: a verbatim copy of the committed golden
// goldens/golden_receipt_03_d20_drand.json, signed by the PUBLIC test key below
// (never a production signer). If the goldens are ever regenerated, this sample
// will visibly verify INVALID on load - the mount auto-verify is the canary.
const SAMPLE_DRAND_RECEIPT = `{
  "alpha": 0.3213648106902838,
  "created_at": "2026-01-01T00:00:00Z",
  "die": "d20",
  "ev": 11.65325625845831,
  "face": 2,
  "id": "00000000-0000-0000-0000-00000000d123",
  "kappa": 0.6,
  "kl": 0.02011901380257613,
  "proof": {
    "drand": {
      "chain_hash": "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
      "client_nonce": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "client_observed_randomness_hex": "9f041d26fd999c82fabf50a22fc7e0be9b068623df1c00d7c8849cdf5da6d25f",
      "client_observed_round": 121,
      "client_observed_signature_hex": "add0b70bf54c5dacfc7289994e085c3a635442f524088b1734c908a4278b2567188d8fa569752d9b4d68e2ccd0e023bd",
      "genesis_time": 1692803367,
      "idem_payload_sha256_hex": "1111111111111111111111111111111111111111111111111111111111111111",
      "period_seconds": 3,
      "public_key": "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
      "scheme": "bls-unchained-g1-rfc9380",
      "target_delay_rounds": 2,
      "target_randomness_hex": "fb8f7bc29bf24db51871ec8c79f3a1e4bd0557bc0dfcee9ed1d924e69d1c60dc",
      "target_round": 123,
      "target_signature_hex": "b75c69d0b72a5d906e854e808ba7e2accb1542ac355ae486d591aa9d43765482e26cd02df835d3546d23c4b13e0dfc92"
    },
    "draw_u64": "1102664356705973204",
    "math_param_version": "roll.math.v1",
    "rng": {
      "algo": "drand-quicknet+HKDF(SHA-256)->ChaCha20Rng",
      "drbg_key_hex": "a5de8cd6e63465bdfe3f4a7e8b5eefbb639b1e6415549567db780e3cd91d62e0"
    }
  },
  "receipt_hash": "sha256:9665b3493f518b738e4bb6ad3d4c9cbc951a45b57369987e3af5a69ca472f8fc",
  "sig": {
    "alg": "Ed25519",
    "canon": "JCS/RFC8785",
    "kid": "test-kid-1",
    "signature_b64": "c8nbZbq4I1OwuNqYpso5ym1ZdhQEYzqdugTTRfbht2Ga9AtS7bw1AmfdIrKzgKAjJ9Gx5rrQ4dIaxWRN3ffCDw=="
  },
  "transcript_url": "/v1/roll/x/transcript",
  "v": "truerolls-drand-1"
}`;

// PUBLIC test verifying key (base64, kid test-kid-1). Signs the sample and the
// goldens. NEVER a production key.
const DEMO_TEST_KEY = 'IHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY=';

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

function shortHash(s: string, head = 10, tail = 6): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readField(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
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

function parseSigKid(text: string): string | null {
  const parsed = parseReceipt(text);
  if (!parsed) return null;
  const kid = asRecord(parsed.sig).kid;
  return typeof kid === 'string' ? kid : null;
}

function statusFrom(ok: boolean | undefined): StratumStatus {
  return ok === undefined ? 'pending' : ok ? 'pass' : 'fail';
}

/**
 * Map the real verifier report + the receipt's own fields onto the forensic
 * strata. Each status comes straight from the engine's per-check booleans; the
 * field values are read verbatim from the receipt. Nothing here re-judges the
 * receipt - it only arranges what the verifier already decided.
 */
function buildStrata(parsed: Record<string, unknown> | null, report: WasmVerifyReport | null): Stratum[] {
  const proof = asRecord(parsed?.proof);
  const rng = asRecord(proof.rng);
  const drand = proof.drand !== undefined ? asRecord(proof.drand) : null;
  const sig = asRecord(parsed?.sig);
  const beacon = drand !== null;

  const strata: Stratum[] = [
    {
      key: 'signature',
      name: 'Signature',
      tag: 'Seal',
      status: statusFrom(report?.valid_signature),
      fields: [
        { label: 'sig.kid', value: readField(sig, 'kid') || '-' },
        { label: 'receipt_hash', value: shortHash(readField(parsed ?? {}, 'receipt_hash')) || '-' },
      ],
      proves:
        'The body, canonicalised (JCS / RFC 8785), verifies against the published Ed25519 key. Any edit cracks the seal.',
      limit: 'Proves integrity and who signed - not when it was signed.',
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
        { label: 'chain', value: shortHash(readField(drand, 'chain_hash')) || '-' },
      ],
      proves:
        'Both the observed and target pulses BLS-verify against the pinned quicknet key, and randomness = SHA256(verified signature).',
      limit:
        'Proves the seed came from a public future beacon - not that the operator could not refuse or suppress a completed roll.',
    });
  } else {
    strata.push({
      key: 'drand',
      name: 'Drand beacon',
      tag: 'Absent',
      status: 'absent',
      fields: [{ label: 'proof.drand', value: 'not present' }],
      proves:
        'This is a legacy truerolls-1 receipt: signature and replay only, with no public-beacon seed provenance.',
      limit: 'No drand provenance. Read it as signed and replayable, not beacon-backed.',
    });
  }

  strata.push(
    {
      key: 'seed',
      name: 'Seed and draw',
      tag: 'Replay',
      status: statusFrom(report?.valid_sampling),
      fields: [
        { label: 'drbg_key_hex', value: shortHash(readField(rng, 'drbg_key_hex')) || '-' },
        { label: 'draw_u64', value: readField(proof, 'draw_u64') || '-' },
      ],
      proves: beacon
        ? 'HKDF re-derives the seed from the verified pulse, then ChaCha20 replays the exact draw - bit for bit.'
        : 'The published seed re-seeds ChaCha20 and replays the exact draw - bit for bit.',
      limit: 'A pure function of public inputs - which is why you can redo it yourself.',
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
        'kd-core rebuilds the guarded distribution from die and κ and lands on the same face. Prefix-CDF, no modulo bias.',
      limit: 'κ shapes bounded risk only. It never moves the draw itself.',
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
      proves: 'α, KL and EV recompute within the caps (tolerance 1e-9).',
      limit: 'The bound is enforced and public; the stance is visible, not hidden.',
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
// "sealed" - the word must not imply a stronger guarantee than a re-derivation
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

export function BehindARoll() {
  const [receiptText, setReceiptText] = useState<string>(SAMPLE_DRAND_RECEIPT);
  const [publicKey, setPublicKey] = useState<string>(DEMO_TEST_KEY);
  const [keyEdited, setKeyEdited] = useState<boolean>(false);
  const [report, setReport] = useState<WasmVerifyReport | null>(null);
  const [wellKnownKeys, setWellKnownKeys] = useState<TruerollsKey[]>([]);
  const [active, setActive] = useState<number>(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => parseReceipt(receiptText), [receiptText]);
  const strata = useMemo(() => buildStrata(parsed, report), [parsed, report]);
  const cells = strata.map((s) => ({
    key: s.key,
    label: SHORT_LABEL[s.key] ?? s.name,
    status: s.status,
    word: stateWord(s.status, s.key),
  }));
  const scrollToPlate = () =>
    document
      .getElementById('specimen-plate')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const runWith = (text: string, key: string) => {
    if (!isKdCoreWasmReady()) {
      setReport({ verdict: 'ERROR', error: 'verifier engine still loading, try again in a moment' });
      return;
    }
    setReport(verifyReceiptWasm(text, key));
    setActive(0);
  };

  // A manually-pasted key is honoured as-is; otherwise the /.well-known key whose
  // kid signed THIS receipt; otherwise the bundled demo test key (so the sample
  // still verifies offline).
  const resolveKeyFor = (text: string, keys: TruerollsKey[]): string => {
    const sigKid = parseSigKid(text);
    const match = sigKid ? keys.find((k) => k.kid === sigKid) : undefined;
    return match?.public_key ?? DEMO_TEST_KEY;
  };

  const verify = (text: string, edited: boolean = keyEdited) => {
    // A key the user typed wins as-is; otherwise resolve well-known/demo by kid.
    // `edited` is threaded explicitly so loadSample/onFile can force a re-resolve
    // without waiting on the async keyEdited state update.
    const key = edited ? publicKey : resolveKeyFor(text, wellKnownKeys);
    setPublicKey(key);
    runWith(text, key);
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
        /* no live API - the bundled demo key verifies the sample offline */
      }
      if (cancelled) return;
      setWellKnownKeys(keys);
      const key = resolveKeyFor(SAMPLE_DRAND_RECEIPT, keys);
      setPublicKey(key);
      runWith(SAMPLE_DRAND_RECEIPT, key);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onReceiptChange = (text: string) => {
    setReceiptText(text);
    setReport(null);
  };

  const loadSample = () => {
    setReceiptText(SAMPLE_DRAND_RECEIPT);
    setKeyEdited(false);
    verify(SAMPLE_DRAND_RECEIPT, false);
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
    setKeyEdited(false);
    verify(text, false);
  };

  const step = (delta: number) => {
    if (strata.length === 0) return;
    setActive((a) => (a + delta + strata.length) % strata.length);
  };

  const verdict = report?.verdict;
  const isError = verdict === 'ERROR';
  const isValid = verdict === 'VALID';
  const verdictWord = isError ? 'UNVERIFIABLE' : isValid ? 'VALID' : 'INVALID';
  const verdictClass = isError ? css.verdictError : isValid ? css.verdictValid : css.verdictInvalid;
  const isLegacy = parsed !== null && readField(parsed, 'v') === 'truerolls-1';

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
          The receipt is the residue of a roll. Move the loupe down its strata: each layer is{' '}
          <b>recomputed in your browser</b> by the same engine the CLI runs, and assayed against the
          bytes. Nothing here is the server's word for it.
        </p>
      </section>

      <div className={css.standing} role="note">
        <span className={css.standingKey}>Standing limit</span>
        <span className={css.standingVal}>
          Proves <b>seed provenance and replay</b>. Does <b>not</b> prove the operator could not
          refuse, time out, or suppress an unfavourable attempt before this receipt existed.
        </span>
      </div>

      <ContactSheet
        cells={cells}
        active={active}
        verdict={report?.verdict}
        onSelect={(i) => {
          setActive(i);
          scrollToPlate();
        }}
      />

      <CeremonyRail parsed={parsed} onReExamine={scrollToPlate} />

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

          <textarea
            className={css.textarea}
            value={receiptText}
            spellCheck={false}
            onChange={(e) => onReceiptChange(e.target.value)}
            aria-label="Receipt JSON"
          />

          <label className={css.keyLabel} htmlFor="pubkey">
            Ed25519 public key (base64)
          </label>
          <input
            id="pubkey"
            className={css.keyInput}
            value={publicKey}
            spellCheck={false}
            onChange={(e) => {
              setPublicKey(e.target.value);
              setKeyEdited(true);
              setReport(null);
            }}
          />

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
            <span className={css.localBadge}>● recomputed locally</span>
          </div>

          <div className={`${css.verdict} ${verdictClass}`} role="status" aria-live="polite">
            <span className={css.verdictWord}>{verdictWord}</span>
            <span className={css.verdictSub}>
              {isError
                ? report?.error
                : isValid
                  ? isLegacy
                    ? 'Signed and replayable. Legacy receipt - no drand provenance.'
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
                  type="button"
                  className={`${css.band} ${focused ? css.focus : ''} ${stateClass}`}
                  aria-expanded={focused}
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
                    {focused && (
                      <div className={css.bandDetail}>
                        <p className={css.proves}>{s.proves}</p>
                        <p className={css.limit}>
                          <span className={css.limitTag}>Limit</span> {s.limit}
                        </p>
                      </div>
                    )}
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
              {report.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </InkFrame>
      </div>

      <section className={css.honest}>
        <h2 className={css.honestTitle}>What a sealed plate proves. And what it doesn't.</h2>
        <p>
          When every stratum holds, the roll is <b>drand-seeded and bit-for-bit replayable</b> - and
          you confirmed it yourself, with no server in the loop. It does <b>not</b> prove the operator
          could not have privately failed an unfavourable attempt and published only this one.
          Strict witnessed fairness is the v2 protocol, not this per-roll drand receipt.
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

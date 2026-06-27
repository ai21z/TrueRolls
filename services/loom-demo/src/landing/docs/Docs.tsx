import { useEffect, useState } from 'react';
import { InkFrame } from '../system/InkFrame';
import { SiteSignature } from '../system/SiteSignature';
import css from './Docs.module.css';

interface TocItem {
  id: string;
  label: string;
}

const TOC: TocItem[] = [
  { id: 'overview', label: 'What is TrueRolls' },
  { id: 'how-it-works', label: 'How it works: the math' },
  { id: 'receipt', label: 'The receipt (drand)' },
  { id: 'verify', label: 'Verify it yourself' },
  { id: 'threat-model', label: "What's proven. And what isn't" },
  { id: 'api', label: 'API & transparency' },
];

/** Active-section highlight in the TOC (optional nicety). */
function useActiveSection(ids: string[]): string {
  const [active, setActive] = useState<string>(ids[0] ?? '');
  // Stable key so the effect doesn't re-run on every render (ids is a fresh array each time).
  const idsKey = ids.join(',');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sectionIds = idsKey.split(',');
    const els = sectionIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;

    // The active section is the last one whose top has scrolled above a line
    // just below the sticky bar — robust regardless of section length. We use
    // an IntersectionObserver purely as the trigger (it fires on any scroll,
    // including programmatic), then recompute from live geometry.
    const LINE = 120;

    const recompute = () => {
      let current = sectionIds[0] ?? '';
      for (const el of els) {
        if (el.getBoundingClientRect().top <= LINE) current = el.id;
      }
      setActive(current);
    };

    // Clamp the bottom margin to >= 0. A short viewport (or innerHeight read as 0
    // mid-navigation) would otherwise yield a "--Npx" rootMargin, which throws
    // ("rootMargin must be specified in pixels or percent") and unmounts the app.
    const bottom = Math.max(0, window.innerHeight - LINE - 1);
    const observer = new IntersectionObserver(recompute, {
      // Thin tracking band at the LINE; fires as each section crosses it.
      rootMargin: `-${LINE}px 0px -${bottom}px 0px`,
    });
    els.forEach((el) => observer.observe(el));
    recompute();
    // Recompute on resize too, since the band height depends on innerHeight.
    window.addEventListener('resize', recompute, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', recompute);
    };
  }, [idsKey]);

  return active;
}

interface CodeBlockProps {
  label: string;
  right?: string;
  children: React.ReactNode;
}

function CodeBlock({ label, right, children }: CodeBlockProps) {
  return (
    <InkFrame seed={70 + label.length} className={css.codeCard}>
      <div className={css.codeHead}>
        <span>{label}</span>
        {right && <span>{right}</span>}
      </div>
      <pre className={css.codeBody}>{children}</pre>
    </InkFrame>
  );
}

export function Docs() {
  const active = useActiveSection(TOC.map((t) => t.id));

  // Deep-link: arriving with #docs-<section> (e.g. from the Verify page's
  // "threat model" link, or a copied/new-tab TOC link) scrolls to that section.
  useEffect(() => {
    const scrollToHash = () => {
      const m = window.location.hash.match(/^#\/?docs-(.+)$/);
      if (m) document.getElementById(m[1])?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const t = setTimeout(scrollToHash, 60);
    window.addEventListener('hashchange', scrollToHash);
    return () => {
      clearTimeout(t);
      window.removeEventListener('hashchange', scrollToHash);
    };
  }, []);

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
        <span className={css.barLabel}>Docs</span>
      </header>

      <div className={css.shell}>
        <nav className={css.toc} aria-label="On this page">
          <span className={css.tocTitle}>On this page</span>
          <ul className={css.tocList}>
            {TOC.map((t) => (
              <li key={t.id}>
                <a
                  href={`#docs-${t.id}`}
                  className={active === t.id ? css.tocLinkActive : css.tocLink}
                  onClick={(e) => {
                    e.preventDefault();
                    document
                      .getElementById(t.id)
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  {t.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className={css.content}>
          {/* ── 1. Overview ───────────────────────────────────────────── */}
          <section id="overview" className={css.section}>
            <span className={css.eyebrow}>Overview</span>
            <h1 className={css.h1}>What is TrueRolls</h1>
            <p className={css.lead}>
              TrueRolls is a deterministic, signed, independently replayable dice
              system. Behaviour can shape bounded risk through pure math. But every
              roll returns an Ed25519-signed receipt that anyone can verify, offline.
            </p>
            <p className={css.p}>
              Today it proves deterministic replay and signing. It does <em>not</em>{' '}
              yet claim provable fairness against a malicious server. And we say so
              plainly (see{' '}
              <a
                className={css.inlineLink}
                href="#docs-threat-model"
                onClick={(e) => {
                  e.preventDefault();
                  document
                    .getElementById('threat-model')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                what's proven
              </a>
              ). One engine, <code className={css.code}>kd-core</code>, runs the
              math in Rust, in the CLI, and in your browser via WebAssembly,
              bit-for-bit.
            </p>
          </section>

          {/* ── 2. How it works ───────────────────────────────────────── */}
          <section id="how-it-works" className={css.section}>
            <span className={css.eyebrow}>The math</span>
            <h2 className={css.h2}>How it works: the math</h2>

            <dl className={css.defList}>
              <div className={css.defRow}>
                <dt className={css.dt}>Karma (κ)</dt>
                <dd className={css.dd}>
                  A signed stance in <code className={css.code}>[-1, 1]</code>. At κ=0
                  the die is perfectly uniform (fair). Positive κ tilts the odds toward
                  high faces; negative κ toward low faces.
                </dd>
              </div>
              <div className={css.defRow}>
                <dt className={css.dt}>Shaping</dt>
                <dd className={css.dd}>
                  Face values are standardized to zero-mean / unit-variance scores{' '}
                  <code className={css.code}>g</code>. Logits are{' '}
                  <code className={css.code}>z = λ·κ·g</code> (
                  <code className={css.code}>λ = 0.50</code>). A numerically stable
                  softmax turns them into a tilted distribution{' '}
                  <code className={css.code}>p̃</code>.
                </dd>
              </div>
              <div className={css.defRow}>
                <dt className={css.dt}>Guards</dt>
                <dd className={css.dd}>
                  The important part. The tilt is bounded by two caps, a KL-divergence
                  cap in nats (<code className={css.code}>d6 ≤ 0.060</code>,{' '}
                  <code className={css.code}>d20 ≤ 0.035</code>,{' '}
                  <code className={css.code}>d100 ≤ 0.025</code>) and an expected-value
                  cap (
                  <code className={css.code}>
                    |EV − EV_uniform| ≤ 0.20·SD_uniform
                  </code>
                  ). The engine mixes <code className={css.code}>p̃</code> back toward
                  uniform by the smallest amount <code className={css.code}>α</code>{' '}
                  that satisfies <em>both</em> caps. So a roll can never bend further
                  from fair than the caps allow. And the receipt records{' '}
                  <code className={css.code}>α</code>, KL and EV so you can check it
                  stayed inside them.
                </dd>
              </div>
              <div className={css.defRow}>
                <dt className={css.dt}>Sampling</dt>
                <dd className={css.dd}>
                  A single 64-bit draw maps to a face by inverse-CDF (prefix sum), no
                  modulo bias. Same inputs → same face, always.
                </dd>
              </div>
            </dl>

            <p className={css.exampleLabel}>Worked line</p>
            <p className={css.example}>
              d20 · κ +0.60 → α 0.32, KL 0.020 (≤ 0.035), EV 11.65
            </p>
          </section>

          {/* ── 3. The receipt ────────────────────────────────────────── */}
          <section id="receipt" className={css.section}>
            <span className={css.eyebrow}>Receipt</span>
            <h2 className={css.h2}>The receipt (truerolls-drand-1)</h2>
            <p className={css.p}>
              Each live roll returns a <code className={css.code}>truerolls-drand-1</code>{' '}
              receipt: a JSON object whose math fields and drand proof are sealed by an
              Ed25519 signature over the JCS (RFC 8785) canonicalization of the body.
            </p>

            <CodeBlock label="receipt" right="truerolls-drand-1">
{`{
  "v": "truerolls-drand-1",
  "id": "<uuid>",
  "die": "d20", "kappa": 0.6, "face": 14,
  "alpha": 0.321, "kl": 0.0201, "ev": 11.65,
  "created_at": "<rfc3339>",
  "transcript_url": "/v1/roll/<id>/transcript",
  "proof": {
    "math_param_version": "roll.math.v1",
    "rng": {
      "drbg_key_hex": "<32-byte hex>",
      "algo": "drand-quicknet+HKDF(SHA-256)->ChaCha20Rng"
    },
    "draw_u64": "<stringified u64>",
    "drand": {
      "chain_hash": "52db9b…e971",
      "client_nonce": "<32 random bytes, hex>",
      "client_observed_round": 123,
      "target_round": 125,
      "target_signature_hex": "<drand BLS signature>",
      "target_randomness_hex": "<sha256(signature)>"
    }
  },
  "sig": {
    "alg": "Ed25519",
    "kid": "<key id>",
    "signature_b64": "<sig>",
    "canon": "JCS/RFC8785"
  }
}`}
            </CodeBlock>

            <p className={css.note}>
              The draw is derived from a verified future drand quicknet pulse. The verifier
              checks the BLS beacon signature, recomputes the HKDF seed, replays the draw,
              and checks the signature over the receipt body. Changing any field breaks at
              least one check.
            </p>
          </section>

          {/* ── 4. Verify it yourself ─────────────────────────────────── */}
          <section id="verify" className={css.section}>
            <span className={css.eyebrow}>Don't trust. Verify.</span>
            <h2 className={css.h2}>Verify it yourself</h2>
            <p className={css.p}>
              Five independent checks any drand receipt verifier runs, derived 1:1 from the receipt:
            </p>

            <ul className={css.checkList}>
              <li className={css.checkItem}>
                <span className={css.pip} aria-hidden="true">✓</span>
                <span className={css.checkText}>
                  <b>Signature (Ed25519)</b>, the body is genuinely signed by the
                  published key.
                </span>
              </li>
              <li className={css.checkItem}>
                <span className={css.pip} aria-hidden="true">✓</span>
                <span className={css.checkText}>
                  <b>Drand beacon proof</b>, the target quicknet signature verifies under
                  the pinned public key and matches the target round.
                </span>
              </li>
              <li className={css.checkItem}>
                <span className={css.pip} aria-hidden="true">✓</span>
                <span className={css.checkText}>
                  <b>Seed replay</b>, re-deriving ChaCha20 from the verified drand beacon
                  reproduces <code className={css.code}>draw_u64</code>.
                </span>
              </li>
              <li className={css.checkItem}>
                <span className={css.pip} aria-hidden="true">✓</span>
                <span className={css.checkText}>
                  <b>Face recompute</b>, the distribution + draw reproduce the claimed
                  face.
                </span>
              </li>
              <li className={css.checkItem}>
                <span className={css.pip} aria-hidden="true">✓</span>
                <span className={css.checkText}>
                  <b>Metrics</b>, recomputed α / KL / EV match the receipt (and sit
                  inside the caps).
                </span>
              </li>
            </ul>

            <p className={css.p}>How you verify:</p>
            <ul className={css.wayList}>
              <li className={css.wayItem}>
                <b>In your browser</b>, with no server call and nothing to install, using
                the same <code className={css.code}>kd-core</code> compiled to WASM. The{' '}
                <a className={css.inlineLink} href="#verify">
                  in-browser verifier
                </a>{' '}
                checks a receipt, and lets you tamper with one, live.
              </li>
              <li className={css.wayItem}>
                The receipt carries its own proof and the key is published, so you can verify
                it independently with any Ed25519 tool, not just ours. We never install
                anything on your machine.
              </li>
            </ul>

            <CodeBlock label="verify" right="in your browser · wasm">
{`receipt.json  →  checked locally, no server
`}<span className={css.codeOk}>{`✓ VALID
  signature  OK   (Ed25519)
  sampling   OK   (draw_u64 replayed)
  face       OK
  metrics    OK   (α · KL · EV)`}</span>
            </CodeBlock>

            <p className={css.p}>
              The signing key is published at{' '}
              <code className={css.code}>/.well-known/truerolls-keys.json</code>.
            </p>

            <CodeBlock label="public key" right="/.well-known/truerolls-keys.json">
{`{
  "keys": [
    { "kid": "...", "alg": "Ed25519", "public_key": "<base64>" }
  ]
}`}
            </CodeBlock>
          </section>

          {/* ── 5. Threat model (honesty) ─────────────────────────────── */}
          <section id="threat-model" className={css.section}>
            <span className={css.eyebrow}>Honesty</span>
            <h2 className={css.h2}>What's proven. And what isn't</h2>

            <InkFrame seed={80} className={css.callout}>
              <div className={css.calloutCol}>
                <span className={css.calloutHeadOk}>
                  <span className={css.pip} aria-hidden="true">✓</span> Proven today
                </span>
                <ul className={css.calloutList}>
                  <li>
                    The receipt is internally consistent and Ed25519-signed. Tampering
                    any field is detected.
                  </li>
                  <li>
                    Deterministic replay: from the published draw you reproduce the
                    exact face and math, anywhere.
                  </li>
                  <li>
                    Bounded shaping: the receipt proves the roll stayed inside the KL
                    and EV caps.
                  </li>
                </ul>
              </div>

              <div className={css.calloutDivider} aria-hidden="true" />

              <div className={css.calloutCol}>
                <span className={css.calloutHeadNo}>
                  <span className={css.pipNo} aria-hidden="true">✕</span> Not proven yet
                </span>
                <ul className={css.calloutList}>
                  <li>
                    That the published outcome was unbiased. The operator can still{' '}
                    <b>grind</b> — privately fail/suppress unfavorable attempts after seeing
                    each drand-derived outcome, and publish only a favorable completed receipt.
                    Per-roll drand fixes the seed source; it does not publicly bind the operator
                    to a single attempt before the beacon resolves. That needs strict witnessed fairness.
                  </li>
                  <li>
                    Drand provenance is <b>not</b> the same as strict witnessed v2 fairness,
                    and we do not claim it is.
                  </li>
                </ul>
              </div>
            </InkFrame>

            <h3 className={css.h3}>The path to strict witnessed fairness</h3>
            <p className={css.roadmapTag}>Roadmap beyond per-roll drand</p>
            <ul className={css.wayList}>
              <li className={css.wayItem}>
                Public batch manifests plus a witnessed append-only log, so accepted rolls
                are publicly bound before the target beacon resolves.
              </li>
              <li className={css.wayItem}>
                Independent witness frontier attestations, so the operator cannot claim a
                late commitment was made before seeing the drand target round.
              </li>
            </ul>
          </section>

          {/* ── 6. API & transparency ─────────────────────────────────── */}
          <section id="api" className={css.section}>
            <span className={css.eyebrow}>Contract</span>
            <h2 className={css.h2}>API & transparency</h2>
            <p className={css.p}>
              The HTTP contract is documented in OpenAPI (
              <code className={css.code}>docs/openapi.yaml</code>):
            </p>
            <ul className={css.wayList}>
              <li className={css.wayItem}>
                <code className={css.code}>POST /v1/roll</code> returns a signed
                receipt.
              </li>
              <li className={css.wayItem}>
                <code className={css.code}>POST /v1/verify</code> checks a receipt (or a
                legacy transcript).
              </li>
              <li className={css.wayItem}>
                <code className={css.code}>GET /v1/verify/:id</code> verifies a stored
                roll.
              </li>
              <li className={css.wayItem}>
                <code className={css.code}>GET /.well-known/truerolls-keys.json</code>{' '}
                publishes the key.
              </li>
            </ul>
            <p className={css.note}>
              The verifier and core are intended to be open source. Transparency is
              the point for a trust system. The Studio scenario tool is the separate,
              closed product.
            </p>
          </section>

          <footer className={css.footer}>
            <div className={css.footerRow}>
              <a className={css.brand} href="#">
                true<span className={css.brandAccent}>rolls</span>
              </a>
              <span className={css.footerNote}>
                Deterministic, signed, independently replayable dice.
              </span>
            </div>
            <div className={css.footerSignature}>
              <SiteSignature />
            </div>
          </footer>
        </article>
      </div>
    </main>
  );
}

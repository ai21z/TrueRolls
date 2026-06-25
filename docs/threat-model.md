# TrueRolls — Threat model & honest limits

This document states plainly **what a TrueRolls receipt proves today, and what it does not.** It is written for an external developer evaluating TrueRolls and running the verifier. Every claim here is grounded in the shipping verifier and signer code (`crates/kd-receipt`) and the server integration (`crates/kd-api`). Where a property is *not* implemented, it is listed as roadmap, not glossed over.

TrueRolls is proprietary software; all rights reserved. "You can run the verifier" means the verifier logic is the single shared crate the server, CLI, and browser all execute — it does **not** mean the source is openly licensed or open source.

---

## TL;DR

A signed TrueRolls receipt lets anyone, offline, prove three things about a roll **after the fact**:

1. **Tamper-evidence** — the receipt is bit-for-bit what the server's key signed. Flip one byte of any signed field and the Ed25519 signature fails.
2. **Deterministic replay** — the published draw re-derives exactly from the recorded DRBG key, and the face and metrics re-derive exactly from `(die, kappa, draw)`.
3. **Bounded behavior-weighting** — the math is guard-capped (a KL cap in nats and an EV cap measured against the uniform standard deviation), so the stance parameter `kappa` cannot bend the distribution past those bounds, and a receipt carrying a `kappa` outside its `[-1, 1]` contract is refused rather than verified.

It does **not** prove the *server chose its seed honestly.* Deterministic replay is not adversarial fairness. A server can still grind or withhold seed material before it signs. Pre-commitment to seed material (commit/reveal), an external randomness beacon, a VRF, and transparency-log anchoring are **not implemented** today — they are roadmap.

---

## What a receipt contains

A `truerolls-1` receipt is a JSON object with the roll outcome (`die`, `kappa`, `face`, `alpha`, `kl`, `ev`), a `proof` block, and a `sig` block:

- `proof.rng.drbg_key_hex` — the 32-byte derived DRBG key, hex. This is the *output* of key derivation (HKDF-SHA256 over the roll inputs), **not** the raw input keying material. It is what a verifier reseeds `ChaCha20Rng` with to replay the draw.
- `proof.draw_u64` — the single 64-bit draw taken from that DRBG, encoded as a decimal string.
- `proof.math_param_version` — the engine parameter version the verifier must match exactly.
- `sig` — Ed25519 signature (`alg: "Ed25519"`, `kid`, `signature_b64`, `canon: "JCS/RFC8785"`) over the canonicalized receipt body with the `sig` and `receipt_hash` fields removed.

The signing public key is published at `GET /.well-known/truerolls-keys.json`, which returns a list of key entries — each with a `kid`, `alg: "Ed25519"`, and a base64-encoded 32-byte `public_key`. Pick the entry whose `kid` matches the receipt's `sig.kid`.

---

## What is PROVEN today

### 1. Tamper-evidence (Ed25519 over a canonical body)

The signature covers the JCS / RFC 8785 canonicalization of the receipt body, with `sig` and `receipt_hash` stripped before signing (both are attached *after* signing). Signing and verification go through **one** canonicalization function in the shared crate, so the signer and verifier cannot disagree about which bytes are covered.

Consequence: **any** change to a signed field — `face`, `kappa`, `die`, `draw_u64`, and so on — invalidates the signature. This is exercised by tamper goldens and regression tests: editing the face, the draw, the kappa, or the die each makes `valid_signature` false. A receipt that re-verifies under the published key is byte-for-byte what the holder of that key signed.

What this does *not* give you: it does not prove the signer is honest, only that the receipt is unaltered and was produced by the holder of that key. It is an integrity and authenticity guarantee, not a fairness guarantee.

### 2. Deterministic replay of the draw and the math

Given the receipt and the published key, the verifier independently recomputes everything and compares:

- **Sampling** — reseed `ChaCha20Rng` from `proof.rng.drbg_key_hex`, take one `next_u64()`, and check it equals `proof.draw_u64`.
- **Face** — recompute the guarded distribution from `(die, kappa)` via the core engine, map the draw through the prefix-CDF (inverse-CDF sampling — no modulo bias), and check it equals `face`.
- **Metrics** — recompute `alpha`, `kl`, `ev` and check each within `1e-9`.

A receipt is `VALID` only when **all four** checks (signature, sampling, face, metrics) pass. The receipt version and `math_param_version` are gated: an unknown version or a parameter-version mismatch is a hard error, not a soft "invalid" — the verifier refuses to bless a receipt it cannot reproduce under known rules.

This proves the *published* draw and the *published* math were applied consistently and signed. It says nothing about whether the published draw was the only draw the server could have published.

### 3. Bounded behavior-weighting (the guards)

`kappa` is a behavior stance in `[-1, 1]`. The core engine builds a tilted distribution and then applies the **minimal-α guard** toward uniform that satisfies **both** caps: a KL-divergence cap (in nats) and an expected-value cap (measured against the uniform standard deviation). The verifier recomputes `alpha`/`kl`/`ev` from scratch, so a receipt cannot claim caps it does not actually satisfy.

The `kappa` range is enforced at the core engine itself: the engine returns a `KappaOutOfRange` error for any `kappa` outside `[-1, 1]` (bounds inclusive). Because the signer and the offline verifier both route through that same core entry point, a receipt carrying an out-of-range `kappa` (for example `kappa = 50`) is **refused as structurally unverifiable — the verifier returns a hard error and does not report VALID.** The verifier's regression suite asserts exactly this. The server's roll endpoint additionally rejects out-of-range `kappa` at its input-validation layer.

> Note for readers who have seen older TrueRolls notes claiming "`kappa` is not clamped, so a `kappa = 50` receipt verifies VALID": that note is out of date with respect to the current code. The shipping engine rejects out-of-range `kappa` at the single core entry point both the signer and the verifier use, and the verifier's test suite asserts a `kappa = 50` receipt hard-fails rather than verifying. Verify against the code, not the older note.

---

## What is NOT proven / NOT implemented

These are **not** in TrueRolls today. Do not assume any of them.

| Property | Status |
| --- | --- |
| Pre-commitment to seed material (commit/reveal) | **Not implemented** (roadmap) |
| External / public randomness beacon | **Not implemented** (roadmap) |
| VRF (verifiable random function) | **Not implemented** (roadmap) |
| Merkle / transparency-log anchoring of receipts | **Not implemented** (roadmap) |
| On-chain anything | **Not implemented** (roadmap) |
| Authentication on the roll/verify endpoints | **Not implemented** |
| Rate limiting *as a fairness / trust control* | **Not a trust control** — an abuse throttle exists (see Operational limits); it does not constrain seed choice |
| Public / adversarial fairness protocol | **Not implemented** (roadmap) |

The receipt proves **replay**, not **fairness.** Closing that gap requires a protocol where the seed is bound to a value the server cannot choose after the fact (for example, a pre-commitment plus an externally-unpredictable, bias-resistant beacon). None of that is shipped. Any claim to the contrary would be false.

---

## The seed-grinding gap (read this)

The server derives the DRBG key itself. From the roll inputs (the idempotency key, a SHA-256 hash of the canonical roll payload, and an optional caller-supplied seed), it computes `HKDF-SHA256 → ChaCha20Rng`, takes the draw, then signs the result. **Nothing in the protocol forces the server to commit to its seed inputs before it sees the outcome.**

So a server that wanted to bias results is *not prevented* by anything in a TrueRolls receipt. Before signing, it could:

- try multiple candidate seeds and publish only the one whose face it likes (**grinding**), or
- compute the outcome and decline to issue a receipt it dislikes (**withholding / last-look**).

The receipt would still verify `VALID`, because replay determinism is exactly what makes grinding cheap for the server: the same inputs always give the same favorable output it selected. **Deterministic replay is not adversarial fairness.** This is the single most important honest limit in TrueRolls, and it is open by design until pre-commitment plus an external beacon are implemented.

A caller-supplied seed mixes into the derivation but does **not** close this gap on its own: the server still observes the caller's seed and derives (and could grind) on top of it before signing.

---

## What an attacker can / cannot do

Assume the published signing key is the server's genuine key (from `/.well-known/truerolls-keys.json`) **and that the client actually runs the verifier against it** — an unverified receipt guarantees nothing.

**A third party (not the server) — e.g. someone who intercepts or stores a receipt — CANNOT:**

- Alter any signed field of a receipt without breaking the Ed25519 signature.
- Forge a new receipt under the server's key without the server's private key.
- Make a tampered draw, face, kappa, or die re-verify — the recomputation catches the inconsistency *and* the signature breaks.
- Get an out-of-range `kappa` receipt to report VALID — the core rejects it and the verifier returns a hard error.

**A third party CAN:**

- Read a receipt's contents, and read the transcript if they can reach it (see "Operational and disclosure limits" below). Receipts and transcripts carry the roll details in the clear; treat them as non-secret.

**A malicious or curious *server* (holder of the signing key) CANNOT (relative to a VALID verdict the client checks):**

- Make the math exceed its declared KL/EV bounds for a given `(die, kappa)` — the verifier recomputes and would reject.
- Have a `kappa` outside `[-1, 1]` accepted — the core rejects it on both sign and verify.
- Retroactively change a receipt it already issued without breaking its own signature.

**A malicious server CAN (this is the unclosed part):**

- **Grind** seed inputs and publish only a favorable outcome.
- **Withhold** an unfavorable outcome (refuse to issue the receipt).
- Choose *when* and *whether* to roll. TrueRolls does not constrain seed timing today.

A signed receipt therefore protects you against everyone *except* a dishonest server's pre-signing seed choice. If your threat model includes the server itself, a TrueRolls receipt alone is **not** sufficient — that is precisely the gap the beacon / commit-reveal roadmap targets.

---

## Operational and disclosure limits

- **Transcript exposure.** The signed receipt is the verifiable artifact. The transcript (served at `GET /v1/roll/:id/transcript`, and typically also stored as a separate object) is distinct from the receipt; whether it is reachable, and with what auth, depends on deployment. Reaching a transcript is **not** the same as cryptographically verifying a receipt, and transcript availability says nothing about privacy. State your deployment's transcript access posture explicitly; do not assume it is private or public.
- **Demo / mock verification is not cryptographic verification.** Any in-page "verify" affordance in a demo or marketing surface that does not run the actual `kd-receipt` checks against the published key proves nothing. Only the shared verifier — the CLI (`kd verify --receipt`), the WASM build, or `POST /v1/verify` (which delegates to the same `kd-receipt` code) — constitutes verification.
- **Test keys are not production keys.** A published test signing seed exists for goldens and demos. Under the production profile, the server refuses to boot if configured with that test seed, a known test `kid`, or no signer at all. A receipt signed by the test key is real only as a demo — verify against the key the production server actually publishes.
- **No authentication.** The roll and verify endpoints provide no authentication today. Do not rely on identity or access control at this layer.
- **Rate limiting is an abuse throttle, not a trust control.** `POST /v1/roll` is rate-limited per client IP (configurable). This exists to throttle abuse and load; it does **not** authenticate callers and does **not** constrain the server's seed choice or fairness in any way. The IP key is derived from forwarding headers, so it is only meaningful when the service runs behind a trusted proxy — a direct client could otherwise spoof its source. Do not treat rate limiting as a security or fairness guarantee.

---

## How to verify a receipt yourself

1. Fetch the server's public key from `GET /.well-known/truerolls-keys.json` and pick the entry whose `kid` matches the receipt's `sig.kid`.
2. Run the offline verifier against the receipt JSON and that public key — either the CLI (`kd verify --receipt`), the WASM build in a browser, or `POST /v1/verify` (all run the same `kd-receipt` code).
3. Accept the roll only if the verdict is `VALID` — i.e. signature **and** sampling replay **and** face **and** metrics all pass.

A `VALID` verdict means: *this receipt is unaltered, was signed by that key, and the draw, face, and bounded math all reproduce.* It does **not** mean: *the server could not have chosen a seed it preferred.* Hold both of those in mind at once — that is the honest state of TrueRolls today.
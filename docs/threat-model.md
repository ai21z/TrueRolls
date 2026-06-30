# TrueRolls, Threat model & honest limits

This document states what a TrueRolls receipt proves today and what it does not. Claims here are grounded in the shipping verifier/signing code (`crates/kd-receipt`), the drand verifier/derivation layer (`crates/kd-drand`), and the server integration (`crates/kd-api`).

TrueRolls is proprietary software, all rights reserved. "You can run the verifier" means the verifier logic is shared by the server, CLI, and browser. It does not mean the source is openly licensed.

## TL;DR

Live TrueRolls rolls mint `truerolls-drand-1` receipts. A receipt that verifies `VALID` proves:

1. **Tamper-evidence**, the receipt is bit-for-bit what the server's Ed25519 key signed.
2. **Drand seed provenance**, the roll seed re-derives from a BLS-verified drand quicknet target pulse, with `target_round = client_observed_round + 2`.
3. **Deterministic replay**, the draw, face, and metrics reproduce from the receipt.
4. **Bounded behavior-weighting**, the distribution is guard-capped by KL/EV limits, and out-of-range `kappa` is refused.

It does **not** prove the published outcome was unbiased: because the operator's attempt is not publicly committed before the target round resolves, it can still **grind**, privately fail/suppress unfavorable attempts and publish only a favorable completed receipt (withholding/refusal is the mechanism). Strict witnessed fairness, one committed attempt per roll, is the v2 protocol, not this per-roll drand receipt.

## Receipt versions

### `truerolls-drand-1`, live product

The live roll endpoint requires:

- `client_nonce`: client-generated 32 random bytes encoded as 64 hex characters.
- `drand.client_observed_round`: the quicknet round the client saw.
- `drand.client_observed_signature_hex` and `drand.client_observed_randomness_hex`: the BLS signature and `SHA256(signature)` for that observed round.
- `drand.target_round`: exactly `client_observed_round + 2`.

The server verifies the client-observed pulse, verifies the target formula, waits for the future target pulse, verifies the target BLS signature against the pinned quicknet key, derives the seed with HKDF-SHA256, rolls through `kd-core`, signs the receipt, and stores the final receipt for idempotent retry.

The receipt carries the drand proof so offline verifiers can repeat the same checks.

### `truerolls-1`, legacy saved receipts

Legacy receipts remain verifiable for goldens and older saved artifacts. They prove signature, replay, face, and metrics, but they do not carry drand provenance.

## What is proven

### 1. Tamper-evidence

The signature is Ed25519 over the JCS / RFC 8785 canonical receipt body with `sig` and `receipt_hash` removed. Signing and verification use the same canonicalization function. Any edit to signed fields invalidates the signature.

This proves the receipt is unaltered and was signed by the holder of the named key. It does not prove the signer is honest.

### 2. Drand seed provenance

For `truerolls-drand-1`, the verifier checks:

- chain hash equals quicknet `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`,
- scheme equals `bls-unchained-g1-rfc9380`,
- public key, period, and genesis time match the pinned quicknet constants,
- the client-observed BLS signature verifies,
- `target_round = client_observed_round + 2`,
- the target BLS signature verifies,
- both randomness fields equal `SHA256(signature)`,
- `proof.rng.drbg_key_hex` re-derives from the target randomness plus the canonical request binding.

This proves the seed came from a real public drand target pulse and is bound to the client's nonce/request.

The minting API also refuses a roll when its `target_round` is not future versus the server-side freshness frontier:
`max(latest BLS-verified relay round, local wall-clock quicknet schedule round)`. That check is a live server
admission rule, not an offline receipt-verifier proof. The offline verifier can only replay the completed receipt.

### 3. Deterministic replay

The verifier reseeds ChaCha20 from `proof.rng.drbg_key_hex`, takes one `next_u64()`, and checks it equals `proof.draw_u64`. It recomputes the distribution from `(die, kappa)`, maps the draw through prefix-CDF sampling, and checks the face.

### 4. Bounded behavior-weighting

`kappa` is a behavior stance in `[-1, 1]`. The engine builds a tilted distribution and applies the minimal-alpha guard toward uniform that satisfies both the KL cap and the EV cap. The verifier recomputes `alpha`, `kl`, and `ev`. A forged claim to looser math fails verification. A receipt with out-of-range `kappa` hard-fails through the same core engine path.

## What is not proven

| Property | Status |
|---|---|
| Operator cannot grind (fail/suppress unfavorable attempts, publish only favorable) | **Not proven** |
| Operator cannot withhold/refuse a roll | **Not proven** |
| Public pre-round anchoring of every roll | **Not implemented in live product** |
| Witnessed transparency log | **v2 protocol, not live product** |
| Commit/reveal | **Not implemented in live product** |
| VRF | **Not implemented** |
| On-chain settlement/anchoring | **Not implemented** |
| Authentication on roll/verify endpoints | **Not implemented** |
| Strict public adversarial fairness | **v2 protocol, not live product** |

Per-roll drand removes the old "server just invented the seed" gap for completed receipts: the seed must re-derive from a verified future drand pulse and the client request binding. It does **not** make the server publicly accountable for attempts it refused to complete, so the operator can still **grind**: try one or many attempts privately and publish only a favorable completed receipt. The seed of any *published* receipt is honest. The *choice* of which to publish is not constrained.

## External fairness-standard mapping

This is a design comparison, not a product classification. If TrueRolls is ever positioned in a
gambling-adjacent or regulated-game context, the current `truerolls-drand-1` receipt should be mapped
honestly against the UK Gambling Commission's RTS 7 standard for random outcomes.

The important RTS 7 point is the no-discard rule. RTS 7B says random inputs should be used in the
order received and should not be discarded due to adaptive behaviour, except when they fall outside
the expected range and the event is logged and investigated. RTS 7A also says external-event outcomes
for lotteries should be unpredictable, externally verifiable, and unable to be influenced by the
operator. Source: UK Gambling Commission, "RTS 7 - Generation of random outcomes", last updated
2024-05-07:
https://www.gamblingcommission.gov.uk/standards/remote-gambling-and-software-technical-standards/rts-7-generation-of-random-outcomes

Current per-roll drand satisfies the **external provenance** side for completed receipts: the target
pulse is public, BLS-verified, pinned to quicknet, and replayable offline. It does **not** satisfy the
**no-discard / operator-uninfluenceable** side because the operator is not publicly committed to one
attempt before the target pulse resolves. A timeout, refusal, or suppressed receipt can hide the
discard of an unfavorable outcome. That is the exact gap v2 witnessed commitments are designed to
close.

## Remaining operator powers

Assume the client verifies the receipt against the genuine published key.

A third party who is not the server cannot:

- alter signed receipt fields without breaking the signature,
- forge a receipt under the server key,
- substitute a fake drand pulse without failing BLS verification,
- get a different face or metrics accepted for the same draw.

A malicious operator cannot, for a completed `VALID` drand receipt:

- replace the drand target pulse with a fake pulse,
- change the target formula away from `observed + 2`,
- claim a seed that does not re-derive from the target drand randomness and request binding,
- exceed the KL/EV bounds without detection,
- alter a receipt after signing without invalidating its own signature.

A malicious operator can still:

- refuse to accept a request,
- time out or fail a roll instead of returning a receipt,
- **grind / outcome-shop:** privately run one or many attempts (other nonces/rounds), observe each drand-derived outcome, fail/suppress the unfavorable ones (a "drand timeout" is an indistinguishable cover), and publish only a favorable completed receipt. There is no public pre-target anchor binding the operator to a single attempt, so the *selection* across discarded attempts biases the result even though every published seed is honestly drand-derived.

That is why the public claim is "drand-backed seed provenance and replay," not "strict witnessed fairness." Closing the grind requires a witnessed, pre-target commitment to one attempt per roll (v2).

## Operational limits

- **No fallback to local RNG in production drand mode.** If drand verification or target fetch fails, the roll fails closed.
- **Idempotency matters.** A retry during the drand wait must resolve to the same in-flight/final roll for the same idempotency key and canonical payload, not choose a fresh target.
- **Transcript exposure.** The signed receipt is the verifiable artifact. Transcript endpoint access is deployment-specific and is not equivalent to receipt verification.
- **Demo/mock verification is not cryptographic verification.** Only `kd-receipt` via CLI, WASM, or server receipt verify is the real verifier.
- **Test keys are not production keys.** Production profile refuses the published test seed and test key id.
- **Rate limiting is an abuse throttle, not a fairness control.**

## How to verify

1. Fetch the issuer key set from `GET /.well-known/truerolls-keys.json` and select the key whose `kid` matches the receipt.
2. Run the offline verifier: browser WASM, CLI `kd verify --receipt`, or `POST /v1/verify`.
3. Accept the receipt only if all reported checks are true.

For `truerolls-drand-1`, a `VALID` verdict means: signed, drand-backed, seed-replayed, face-replayed, and bounded-math-replayed. It does not mean the published outcome was unbiased, the operator can still grind by failing/suppressing unfavorable attempts and publishing only favorable completed receipts.

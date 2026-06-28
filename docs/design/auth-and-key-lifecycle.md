# Auth and Signing-Key Lifecycle for the TrueRolls roll endpoint

> **Provenance.** Design note, 2026-06-28. Addresses operational-security findings against the
> public-deploy posture of `kd-api`: OPS-AUTH-01 (the unauthenticated signing endpoint had no global
> volume/cost ceiling) and OPS-KEY-01/02 (no signing-key rotation or revocation substrate). Part 1's
> global mint cap is implemented on `freature/drand-per-roll`. Everything else is design, not
> implemented, unless explicitly marked otherwise.

Companion notes:

- [`../operational-security-audit.md`](../operational-security-audit.md)
- [`l2-hardening-codex-brief.md`](l2-hardening-codex-brief.md)
- [`global-mint-cap-review-brief.md`](global-mint-cap-review-brief.md)

---

## Part 0 - the two reframes

Two findings need precise wording:

1. **OPS-AUTH-01 is a cost/volume problem, not a forgery problem.** A TrueRolls receipt attests that
   the server ran its bounded-roll math over a BLS-verified drand-derived seed and produced a face.
   The current signed body carries no `user_id`, `wallet`, `stake`, `payout`, `tier`, or entitlement
   field. Ed25519 remains a signature scheme, not an authorization system. The missing control is a
   ceiling on unauthenticated minting work: one accepted roll can consume a signature, DB row, S3
   object, Redis work, and drand relay fetches.

2. **OPS-KEY-02 is not solved by the drand target round.** Every drand receipt carries an externally
   verifiable beacon round used for seed derivation. That is useful provenance, but it is not a
   trusted receipt signing time and not proof that the receipt existed at that round. A key holder
   can sign a new receipt today that embeds an old public drand pulse. For revocation after key
   compromise, a verifier needs independent issuance or existence evidence for the receipt hash:
   an RFC 3161 timestamp token, a transparency-log inclusion checkpoint, an on-chain anchor, or an
   equivalent signed time/evidence system.

The line that flips OPS-AUTH-01 from bounded cost to real forgery is this: if any `user_id`, `wallet`,
`stake`, `payout`, `tier`, or entitlement field enters the signed body, it must be server-derived from
an authenticated principal in a new receipt version. Never echo such fields from the request.

---

## Part 1 - OPS-AUTH-01: bound cost, keep it anonymous

### Tiered model

| Layer | Bounds | Mechanism | Self-host | Status |
|------|--------|-----------|-----------|--------|
| L0 | rate per IP | `tower_governor`, POST-only | yes | shipped |
| L1 | bot vs human | invisible PoW such as ALTCHA, or managed Turnstile | ALTCHA yes | designed |
| L2 | total volume + cost | global fixed-window Redis counter | yes | implemented |
| L3 | attribution / partner quota | hashed API key + per-key counter | yes | designed |

L0 bounds one apparent client. L2 bounds the total unauthenticated mint volume across all source IPs.

### Implemented: the global mint cap

**What it does.** A fixed-window counter in Redis caps the total number of new roll attempts admitted
past the mint-commit point per window. Default window: 3600 seconds. `KD_ROLL_GLOBAL_CAP=0` means
uncapped outside production, or in production only when explicitly opted out.

**Where it sits.** The check is in `post_roll` after:

- the idempotency lock is acquired, so dedup and 202 processing paths have already returned,
- the client drand proof is validated, so invalid proofs fail with 400 before spending quota.

It runs before the target-round wait, receipt signing, DB write, and S3 write.

**Counter semantics.** The Redis counter is a monotonic count of validated reservation attempts in the
window. It includes rejected over-cap attempts because the Lua script increments before comparing with
the cap. Rejected attempts are not minted receipts. This is intentional: refunding or decrementing
rejections creates reject/refund oscillation and weakens the abuse-control property. The security
property is no over-delivery: at most `cap` requests per window are admitted beyond the reservation
gate.

**Atomicity and fail-closed behavior.** `services/quota.rs::reserve_mint` runs one Redis Lua `EVAL`:
`INCR` the window key, then `EXPIRE` it only when the count is 1. Redis runs a script atomically, so
the counter cannot be incremented and left without a TTL by a process crash between separate commands.
Redis errors propagate as non-mints. The roll path already requires Redis for idempotency, so this is a
fail-closed posture.

**Reject behavior.** On `Rejected`, the handler returns:

- HTTP `429 Too Many Requests`,
- `Retry-After: <seconds to window end>`,
- JSON body `{"error":"global_roll_cap_exceeded"}`.

No receipt is signed. The idempotency lock is released with an ownership-checked token so the handler
cannot delete a newer same-key lock after TTL expiry.

**Deliberate trade-off.** A roll that reserves budget and later fails during drand wait, DB write, or
S3 write still consumed a budget unit. That is correct for a cost cap. The expensive attempt happened.
There is no refund path.

**Prod gate.** `Config::validate()` refuses to boot under `KD_ENV=prod` when `roll_global_cap == 0`
and `KD_ALLOW_UNCAPPED_ROLL` is not set. A production operator must set a finite cap or explicitly opt
out.

**Config.**

- `KD_ROLL_GLOBAL_CAP`: u64, `0` means uncapped.
- `KD_ROLL_GLOBAL_CAP_WINDOW_SECS`: u64, default `3600`, minimum `1`.
- `KD_ALLOW_UNCAPPED_ROLL`: truthy opt-out for production.

---

## Part 2 - OPS-KEY-01/02: rotation and revocation

Status: designed, not implemented.

### Current verifier and key-discovery reality

The current implementation is simpler than the future design:

- `kd-receipt::verify_receipt(value, public_key_b64)` accepts one caller-supplied Ed25519 public key.
- `sig.kid` exists in the receipt signature block, but the verifier does not select a key by `kid`.
- `/.well-known/truerolls-keys.json` is shaped as a list, but currently returns one active key.
- `PublicKeyEntry` contains `kid`, `alg`, and `public_key`. It has no validity-window metadata.

Therefore, rotation and revocation are not invisible plumbing. They require verifier semantics changes.

### Correct drand round time formula

The code maps quicknet round 1 to genesis:

```text
round_time = genesis + (round - 1) * period
```

The inverse in `kd-drand::quicknet_round_at_unix_seconds` returns 0 before genesis and 1 at genesis.
If a future key-validity policy uses round times, it must use the same boundary convention or it will
be off by one round.

### Rotation: multi-kid key set

Rotation is feasible:

- Publish a key set, not one key.
- Give each key a `kid`.
- Sign new receipts with one active kid.
- Keep retired uncompromised verify-only keys published permanently, because receipts do not expire.
- Update `kd-receipt` to select the public key by `receipt.sig.kid`.

Removing an old uncompromised key from the published set invalidates honest historical receipts. That
is not rotation, it is history deletion.

### Revocation: what drand can and cannot prove

Drand can prove that a beacon pulse is genuine. It cannot prove when a receipt was signed. A leaked
Ed25519 key can sign a fresh receipt today while embedding an old valid drand pulse. If the verifier
only checks that `target_round` falls inside a kid validity window, the forged receipt can appear to
belong to the old window.

So drand-round validity windows alone do not solve key-compromise revocation.

Honest revocation needs independent issuance or existence evidence for the receipt hash, for example:

- an RFC 3161 timestamp token over the receipt hash,
- inclusion of the receipt hash in a witnessed append-only transparency log,
- a Rekor/CT-style log entry with inclusion and consistency proofs,
- an on-chain anchor,
- an equivalent signed and externally verifiable issuance-time substrate.

With that substrate, a verifier can ask two separate questions:

1. Was the receipt body and signature cryptographically valid?
2. Did this exact receipt hash exist before the key was revoked?

Without that second evidence object, a compromised key remains able to manufacture old-looking receipts.

### Future verifier contract

A future revocation-capable verifier would need:

- a key set, not a single public key,
- selection by `sig.kid`,
- validity metadata for each key,
- issuance evidence for each receipt hash,
- policy for unknown kids, revoked kids, expired windows, and missing timestamps/log proofs.

This is not a transparent change to existing callers. CLI and WASM callers currently pass a single key.
They would need to fetch or receive a key set plus the revocation/issuance evidence policy.

### Practical ship order

1. Multi-kid key publication and verifier selection by `sig.kid`.
2. Issuance evidence: timestamp token or transparency-log inclusion for each receipt hash.
3. Revocation policy that uses the issuance evidence, not the drand seed round alone.
4. Optional stronger signing backend: KMS, HSM, or threshold signing.

---

## Status summary

| Item | Finding | Status |
|------|---------|--------|
| Global mint cap (L2) + prod fail-closed gate | OPS-AUTH-01 | implemented |
| Ownership-safe idempotency lock release on cap rejection | OPS-AUTH-01 | implemented |
| ALTCHA invisible PoW (L1) | OPS-AUTH-01 | designed |
| API keys + quota (L3) | OPS-AUTH-01 | designed |
| Multi-kid rotation | OPS-KEY-01 | designed |
| Revocation using issuance timestamp/transparency evidence | OPS-KEY-02 | designed, not implemented |
| Drand-round-only revocation windows | OPS-KEY-02 | rejected as insufficient |
| Unleakable key backend | OPS-KEY-02 | designed fork |
| Signed transparency/revocation log | OPS-KEY-02 | required substrate for strong revocation |

---

## Source model used for the revocation correction

- RFC 3161 Time-Stamp Protocol: a TSA creates time-stamp tokens to indicate that a datum existed at
  a particular point in time.
- RFC 9162 Certificate Transparency: Merkle consistency proofs prove append-only log growth.
- Sigstore Rekor: auditors monitor the transparency log for append-only consistency and immutable
  entries.
- Sigstore Fulcio/Rekor model: short-lived certificates become useful for later verification when
  signing events or certificates are backed by transparency-log evidence.

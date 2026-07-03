# TrueRolls Signing-Key Rotation Runbook

This runbook covers the implemented Phase 3 key lifecycle for `kd-api`.

## What Exists Today

TrueRolls receipts are signed with Ed25519. The receipt names the signing key in `sig.kid`.
The issuer publishes a key set at:

```text
GET /.well-known/truerolls-keys.json
```

Each key has one status:

| Status | Meaning |
|---|---|
| `active` | Signs new receipts and verifies receipts under this kid. Exactly one key may be active. |
| `retired` | Verifies historical receipts only. Never signs new receipts. |
| `revoked` | Invalidates every receipt under this kid, including honest receipts. |

The status-aware verifier selects by `sig.kid`. Unknown, duplicate, non-Ed25519, or revoked keys fail
verification. A manual single-public-key verifier still exists for audits, but it bypasses status.

## What Does Not Exist Today

There is no time-scoped revocation. Drand `target_round` proves seed provenance, not signing time.
A leaked signing key can sign a new receipt today that embeds an old drand pulse.

Time-scoped revocation requires independent issuance evidence over the receipt hash, such as:

- RFC 3161 timestamp token,
- witnessed transparency-log inclusion,
- on-chain anchor,
- equivalent signed existence evidence.

That is v-next.

## Configuration

Use `KD_SIGNING_KEYS` for multi-key deployments. It must not be combined with the legacy
`KD_SIGNING_ED25519_SECRET` / `KD_SIGNING_KID` pair.

Example:

```json
[
  {
    "kid": "issuer-2026-07",
    "status": "active",
    "secret_hex": "<64 hex chars>"
  },
  {
    "kid": "issuer-2026-06",
    "status": "retired",
    "public_key": "<base64 32-byte Ed25519 public key>"
  }
]
```

Rules enforced at boot:

- production requires one active signing key,
- the set must contain exactly one active key,
- duplicate `kid` values are rejected,
- `active` requires `secret_hex`,
- `retired` and `revoked` require `public_key` or `secret_hex`,
- production rejects published test kids, published test seeds, and their published public keys.

## Normal Rotation

Goal: start signing new receipts with a new key without invalidating old receipts.

1. Generate a new 32-byte Ed25519 signing seed outside the repo.
2. Choose a new `kid`, for example `issuer-2026-08`.
3. Add the new key as `active`.
4. Move the old active key to `retired` and keep its public key in the published set.
5. Deploy the new `KD_SIGNING_KEYS` value.
6. Verify `/.well-known/truerolls-keys.json` shows exactly one `active` key and the old key as
   `retired`.
7. Mint a test receipt and verify it with the browser, CLI, and server verifier.
8. Verify an older receipt under the retired kid still returns `VALID`.

Never remove a retired, uncompromised key. Removing it invalidates historical receipts and is history
deletion, not rotation.

## Emergency Revocation

Goal: stop accepting receipts under a compromised kid.

1. Treat the incident as a signing-key compromise.
2. Generate and deploy a new active key.
3. Change the compromised kid to `revoked`.
4. Keep the compromised public key in the published set with `status: "revoked"` so verifiers can
   return an explicit revoked-key reason instead of "unknown key".
5. Publish an operator notice stating the blunt effect: every receipt under that kid is invalid,
   including honest receipts minted before the incident.
6. Do not claim time-scoped preservation unless the receipts have independent issuance evidence.

Emergency example:

```json
[
  {
    "kid": "issuer-2026-08",
    "status": "active",
    "secret_hex": "<new 64 hex chars>"
  },
  {
    "kid": "issuer-2026-07",
    "status": "revoked",
    "public_key": "<old base64 public key>"
  },
  {
    "kid": "issuer-2026-06",
    "status": "retired",
    "public_key": "<older base64 public key>"
  }
]
```

## Verification Checklist

After every key lifecycle change:

```powershell
cargo test -p kd-receipt --lib
cargo test -p kd-api --bin kd-api
cargo test -p kd-core-wasm --lib
cargo test -p kd-cli --test goldens
pnpm -C services/loom-demo build
pnpm -C services/loom-demo lint
```

Manual checks:

- `/.well-known/truerolls-keys.json` returns all active, retired, and revoked keys.
- A receipt signed by the active kid verifies `VALID`.
- A receipt signed by a retired kid verifies `VALID`.
- A receipt signed by a revoked kid verifies `INVALID` with a revoked-key reason.
- A receipt with an unknown kid verifies `INVALID` with an unknown-kid reason.

## Public Test Keys

`test-kid-1` and `test-kid-2` are public test keys used for goldens and rotation fixtures. They are
not secrets. Production boot refuses their kids, seeds, and derived public keys, even if a test key is
renamed or carried only as a retired/revoked public key.

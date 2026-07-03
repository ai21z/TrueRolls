# Security Policy

## Reporting

Report security issues privately to the repository owner. Do not publish exploit details until the
owner has confirmed a remediation plan.

Include:

- affected commit or release,
- reproduction steps,
- expected impact,
- logs or receipts needed to reproduce, with secrets removed.

Never send signing seeds, API credentials, database URLs, Redis URLs, or private environment files in
a report.

## Signing-Key Compromise

TrueRolls receipts are Ed25519-signed. The issuer publishes a status-aware key set at:

```text
/.well-known/truerolls-keys.json
```

Key statuses:

- `active`: signs new receipts and verifies receipts under that kid,
- `retired`: verifies historical receipts only,
- `revoked`: invalidates every receipt under that kid.

Revocation is deliberately blunt. If a production signing key is compromised and the kid is marked
`revoked`, every receipt under that kid becomes invalid, including honest historical receipts.

TrueRolls does not currently implement time-scoped revocation. Drand target rounds prove seed
provenance, not receipt signing time. Preserving pre-compromise receipts during a revocation would
require independent issuance evidence over the receipt hash, such as an RFC 3161 timestamp token, a
witnessed transparency-log inclusion checkpoint, an on-chain anchor, or an equivalent system. That is
future work.

## Public Test Keys

`test-kid-1` and `test-kid-2` are public test keys used for goldens and local fixtures. They are not
production keys. Production boot refuses the published test kids, seeds, and derived public keys.

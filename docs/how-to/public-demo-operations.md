# Public Demo Operations

This runbook is for a budgeted, anonymous TrueRolls public demo. It is not partner authentication,
a contractual SLA, strict witnessed fairness, or mature production key custody.

## Release Boundary

A completed `truerolls-drand-1` receipt is signed, derives its seed from verified quicknet pulses,
and replays locally. It does not prove that the operator could not privately refuse or withhold an
unfavorable attempt. Keep that claim boundary in the site, API docs, and incident communications.

## Required Configuration

| Area | Public-demo requirement |
| --- | --- |
| Profile | Set `KD_ENV=prod`. Unknown profile strings fail closed to production. |
| Signer | Inject one non-test active Ed25519 seed through the deployment secret store. Never put it in an image, repository, command log, or public environment dump. Production rejects both published test seeds, kids, and keys before service I/O. Environment-resident seed custody is the current A-tier limit; KMS/HSM custody is later work. |
| Mint budget | Set finite `KD_ROLL_GLOBAL_CAP` and `KD_ROLL_GLOBAL_CAP_WINDOW_SECS`. Do not set `KD_ALLOW_UNCAPPED_ROLL=1` for a public demo. Anonymous callers can consume this shared budget. |
| Client IP | Set `KD_TRUSTED_PROXY` to the real edge contract: `cloudflare`, `fly`, or `xff:<trusted-hops>`. The edge must overwrite or strip caller-supplied forwarding headers. Use `peer` only for direct exposure and set `KD_ALLOW_PEER_IP=1` deliberately. |
| Capacity | Pin `KD_ROLL_MAX_INFLIGHT` and `KD_DB_MAX_CONNECTIONS` together after a load test. The default 32 in-flight requests share five DB connections; no connection is held during the drand wait, but the final write phase still queues on the pool. |
| Timeouts | The conservative default whole-roll timeout is `target_wait + 4 * relay_count * relay_timeout + 2000 ms`: one full `/info` plus pulse pass across all relays for the initial frontier and one possible full pass as the target wait crosses its deadline. Keep the edge timeout above `KD_ROLL_TIMEOUT_MS`. A lower override can cancel honest rolls and consume a monotonic validated reservation attempt without minting a receipt. |
| Public URL | Set `KD_PUBLIC_BASE_URL` to the externally reachable HTTPS issuer origin used in transcript links. |

## Transport And Credentials

- PostgreSQL must use TLS with server identity verification in the managed production URL. Store its
  credential in the deployment secret store, use a least-privilege database role, and restrict the
  network to the API service.
- S3 must use HTTPS with trusted CA validation, a private bucket, and a credential limited to the
  transcript prefix and required object operations. Public bucket access is not required.
- The current Redis build has not been deployment-proven with direct TLS. Keep Redis on a private,
  encrypted service network or TLS sidecar and require authentication. Do not expose port 6379 to the
  public internet. Adding direct `rediss://` support requires an explicit feature change and test.
- Rotate every service credential independently of the receipt signing key.

## CORS And Origin Model

The current API is anonymous and credential-less. `Access-Control-Allow-Origin: *` is intentional for
public browser verification and roll requests, and credentials are not enabled. Do not add cookies,
browser credentials, or partner tokens without replacing wildcard CORS with an explicit allowlist and
adding authentication threat-model and CSRF review.

## Logging, Redaction, And Retention

- Collect stdout/stderr as structured deployment logs. Preserve event names and request correlation
  fields, but never log signing seeds, service URLs containing credentials, raw receipts, client
  nonces, idempotency keys, or transcript bodies.
- Internal 500 responses are sanitized; detailed causes stay server-side.
- Alert on `roll.shed`, `roll.timeout`, global-cap 429s, lock-release failures, drand relay failures,
  signer startup failures, DB pool saturation, Redis memory/evictions, S3 errors, and health
  degradation.
- Bound `/healthz` and `/v1/drand/health` at the deployment edge. The application currently leaves
  both public and unthrottled; they perform backend or public-network work and are operational probes,
  not cost-free endpoints.
- Set and document a provider retention period before deployment. Restrict log access and export an
  incident snapshot before rotation. Local tests do not establish a production retention policy.

## Backup And Restore

PostgreSQL is the durable receipt/idempotency index. S3 is the durable transcript store. Back them up
as one recovery point and record hashes, object counts, UTC, application image ID, and migration
version. Encrypt backups and test restore into an isolated project before relying on them.

Redis is not the durable receipt source. Losing Redis removes concurrency locks and resets the
fixed-window global-cap state. During Redis recovery, stop minting or enforce the remaining budget at
the edge until a full cap window has elapsed.

The controlled local rehearsal uses only the isolated candidate Compose project, verifies project
labels before volume deletion, restores a relational sentinel and S3 object, checks health, and then
removes only candidate resources:

```powershell
docker build --pull --no-cache -t truerolls-kd-api:a-tier-candidate .
pwsh -File scripts/backup-restore-rehearsal.ps1
```

Production commands are provider-specific. Never run the rehearsal script against production or the
ordinary development Compose project.

## Key Rotation And Emergency Revocation

Follow [Key Rotation And Revocation](key-rotation.md). Keep retired uncompromised public keys in the
published key set. A revoked kid makes all receipts under that kid invalid because TrueRolls does not
yet have independent issuance-time evidence. On suspected compromise:

1. stop minting,
2. preserve logs, image ID, key-set bytes, and incident time,
3. deploy a new active key and mark the compromised kid revoked,
4. publish the updated key set through the same issuer origin,
5. communicate that revocation is blunt and affects honest historical receipts under that kid.

## Resource And Billing Alerts

Configure provider alerts for API CPU/memory/restarts, 429/503/504 rate, Postgres connections and
storage, Redis memory/evictions, S3 storage/requests/errors, egress, and the monthly cost ceiling. Set
warning and shutdown thresholds below the owner's budget. A global mint cap bounds receipt volume but
does not bound every read, verification, health, or egress cost.

## Rollback And Incident Response

- Deploy immutable image IDs. Roll back to the last image whose exact SHA passed remote CI and
  deployment smoke tests.
- Migrations are additive today. Before any destructive migration, add a forward/rollback plan and a
  tested backup.
- Never roll back by deleting retired verification keys or reintroducing a revoked signing key.
- For drand outage, fail closed and show the public roll error; do not switch to server-local RNG.
- For cap exhaustion or abuse, keep verification/read access available, pause or reduce minting, and
  preserve evidence before changing limits.
- Record UTC, image ID, config fingerprint without secret values, affected receipt IDs, key-set hash,
  drand rounds/relays, actions, and recovery evidence in every incident report.

## Go/No-Go Checklist

- production profile, signer, proxy, finite cap, pool/concurrency, and timeouts reviewed,
- edge limits for health and drand-health probes configured,
- HTTPS/private-network and least-privilege credentials configured,
- key set reachable and production test-key rejection observed,
- logs, alerts, retention, backups, restore, rollback, and incident contacts configured,
- candidate image health and live tamper workflow pass,
- exact owner commit has green remote deterministic, controlled-integration, and external-network CI.

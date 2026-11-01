# Home-PC Closed Beta

This runbook hosts an invite-only TrueRolls beta from one Windows PC. It is not the public demo
described in [Public Demo Operations](public-demo-operations.md): availability is "when the PC is
on", and the deviations below are accepted only because every tester is invited.

## Topology

```text
tester browser
  |  https://beta.truerolls.dev   Cloudflare Access: invited emails, one-time PIN
  v
Cloudflare edge
  |-- beta.truerolls.dev/*        -> Worker truerolls-beta-site (static assets only)
  |-- beta.truerolls.dev/v1/*     -> no Worker -> Cloudflare Tunnel
  |-- beta.truerolls.dev/livez*   -> no Worker -> Cloudflare Tunnel
  |-- beta.truerolls.dev/healthz* -> no Worker -> Cloudflare Tunnel
  v
cloudflared (outbound only, validates the Access token) -> api:8080 -> postgres, redis, minio
                                                         Compose project truerolls-beta
```

- One hostname serves the site and the API, so the site is built with `VITE_API_URL` empty
  (`pnpm build:beta`). The Access cookie covers both, and the API's anonymous, credential-less CORS
  model is unchanged.
- `/.well-known/truerolls-keys.json` is a static asset of the site, copied from the running API by
  `scripts/beta-keyset.ps1`. Receipts stay verifiable in the browser while the PC is off.
- No container publishes a host port. Postgres, Redis and MinIO are on an internal network with no
  route out. kd-api also joins an egress network for drand; cloudflared uses only that one.
- kd-api runs with `KD_ENV=prod` and `KD_TRUSTED_PROXY=cloudflare`: it takes the client IP from
  `CF-Connecting-IP`, which only Cloudflare's edge can set because the tunnel is the API's only
  entry point. A request without that header is refused. That header is for rate limiting, not
  authentication.
- Access is the only authentication, and the API does not check Access tokens itself. cloudflared
  checks them instead ("Protect with Access" on the tunnel route), so a request that reaches the
  tunnel without passing Access, for example through a misconfigured route, is not forwarded.
- Minting is limited per client IP and by one global cap per hour shared by all testers
  (`KD_ROLL_GLOBAL_CAP`, default 1000). These protect against abuse; they are not per-tester
  budgets, because the API never learns which tester is calling.

## Deliberate Deviations

| Public-demo requirement | Beta on one PC |
| --- | --- |
| Postgres over TLS with server identity verification | Plain TCP on the internal Docker network of a single host |
| S3 over HTTPS, managed storage | The repository's MinIO test fixture, over HTTP on the internal network |
| Secret store for the signing seed | Env file outside the repository, readable only by the owner's Windows account |
| High availability | One instance; down whenever the PC, Docker Desktop or the uplink is down |
| Provider alerts, log retention | `docker compose logs` and Cloudflare analytics; json-file logs capped at 5 x 10 MB per container |

Least privilege still holds where it is cheap: kd-api connects to Postgres as `kd_app`, which owns
only the `kd` database, and to MinIO as `kd-api`, which can list the transcript bucket and get,
put and delete objects in it. kd-api and cloudflared run with a read-only filesystem, no Linux
capabilities and `no-new-privileges`.

The tester CLI path (`kd verify --server`) hits the Access login; browser verification is the
supported path for the beta.

## One-Time Setup

All commands run from the repository root in PowerShell 7.

### 0. Freeze the deployment candidate

Complete scripts, dependency pins and lockfile changes before choosing the deployment SHA. Commit
approval and green remote CI must precede the final API image and site build. Synchronize a clean
local `main` to the approved remote commit without resetting or discarding unrelated work. Record
the full SHA, image ID and site/key-set hashes. A green run for an earlier SHA does not cover new
working changes. If anything tracked changes afterward, repeat the commit, CI and build gates.

Use the pinned Node version in `.node-version` and `corepack pnpm` (the root packageManager pin).
Wrangler is a pinned local devDependency; no global Wrangler install is required. Docker image IDs
and executable hashes are different: compare the executable's SHA-256 separately if checking binary
equality across two image builds.

Review the pinned Cloudflared release and current image scan before enabling the Tunnel. The
digest fixes the image identity, not its vulnerability status. Keep scan findings and any risk
acceptance with the deployment evidence; a successful `--version` run is not a security audit.

### 1. PC

- Docker Desktop: Settings > General > "Start Docker Desktop when you sign in" on. After an unattended
  reboot the API stays down until you sign in; the site keeps loading and verifying receipts.
- Sleep and hibernate on AC: never. Windows Update active hours cover your testing hours.
- BitLocker on the system drive is recommended: the signing seed lives on it.

### 2. Secrets

```powershell
pwsh -File scripts/beta-secrets.ps1
```

This writes `%LOCALAPPDATA%\TrueRolls\beta\beta.env`, readable only by you, and refuses to overwrite
an existing file. Back the file up offline: losing the seed forces a key rotation, and anyone holding
it can sign receipts as the beta issuer.

### 3. API image

Build from a clean checkout of the exact commit that passed CI, and tag it with that commit.

```powershell
git status --porcelain
```

```powershell
docker build -t "truerolls-kd-api:beta-$(git rev-parse --short=12 HEAD)" .
```

`KD_API_IMAGE` in the env file must name that tag; `beta-secrets.ps1` writes the current commit's
tag. Record `docker image inspect --format '{{.Id}}' <tag>` with each deployment.

### 4. Start the stack and check it locally

```powershell
$BetaEnv = "$env:LOCALAPPDATA\TrueRolls\beta\beta.env"
$Beta = @('compose', '-f', 'infra/docker-compose.beta.yml', '--env-file', $BetaEnv)
docker @Beta up -d --wait
docker @Beta ps
docker @Beta exec -T api curl -fsS http://127.0.0.1:8080/healthz
```

`/healthz` returns HTTP 200 even when degraded; accept only a body with `"status":"ok"`.
With `COMPOSE_PROFILES` empty, cloudflared does not start and nothing is reachable from outside.

### 5. Site build and key set

```powershell
corepack pnpm -C services/loom-demo build:beta
pwsh -File scripts/beta-keyset.ps1
```

`build:beta` empties `dist/`, so run the key-set step after every build. It writes
`dist/.well-known/truerolls-keys.json` and prints the active kid, public key and file hash.

```powershell
corepack pnpm -C services/loom-demo beta:dry-run
```

This checks local packaging without uploading or deploying. Confirm the key-set file is in the
asset set; a successful dry run does not prove Cloudflare routing or Access is configured correctly.

### 6. Cloudflare

You do these steps yourself, signed in to your own account. Keep this order: until the Access
application exists, anything published on the hostname is open to the whole Internet.

1. Zero Trust > Access > Applications: create a self-hosted application for the whole hostname
   `beta.truerolls.dev`, login method one-time PIN, one Allow policy "Include: Emails" listing the
   testers, session duration 24 hours. Note the application's Audience (AUD) tag and your Zero Trust
   team name; step 2 needs both.
2. Zero Trust > Networks > Tunnels: create a remotely managed tunnel `truerolls-beta`, and add the
   public hostname route `beta.truerolls.dev` with service `http://api:8080`. Under the route's
   Additional application settings, turn on "Protect with Access" with that team name and AUD tag,
   so cloudflared drops any request without a valid Access token. Then paste the tunnel token into
   `TUNNEL_TOKEN` in the env file, set `COMPOSE_PROFILES=tunnel`, and run
   `docker @Beta up -d --wait` again. Before going on, confirm that a signed-out request to
   `https://beta.truerolls.dev/livez` is sent to the Access login.
3. Workers: deploy `services/loom-demo` with Wrangler (`wrangler.jsonc` there). In the zone's Workers
   Routes, add `beta.truerolls.dev/v1/*`, `beta.truerolls.dev/livez*` and `beta.truerolls.dev/healthz*`
   with Worker "None"; these more specific routes send API traffic past the Worker to the tunnel.
4. Security > WAF: a rate-limiting rule on `/v1/roll`, and bounds on `/healthz` and
   `/v1/drand/health`, which the API leaves unthrottled.

Workers Routes match the query string as well as the path, so the trailing stars are deliberate.
The health prefixes also match paths such as `/livez-extra`; those must reach an API 404, not the
site fallback. See [Cloudflare route matching](https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior).

### 7. Acceptance

| Gate | Check |
| --- | --- |
| G1 routing | Static JS and WASM load from the Worker (WASM has `application/wasm`); `/v1/*`, `/livez` and `/healthz`, including `?x=1`, return API responses, never SPA HTML. `/livez-extra` and `/healthz-extra` return API 404. An unrelated unknown site path gets the site |
| G2 Access | A signed-out request goes to the Access login; an email not on the list is refused; the tunnel route shows "Protect with Access" on, and a signed-in tester can still roll |
| G3 client IP | API logs show your public IP, not a Cloudflare address |
| G4 roll | A live roll returns a `truerolls-drand-1` receipt that the browser verifies |
| G5 key set | The signed-in browser receives key-set JSON, not HTML. `scripts/beta-keyset.ps1 -Check -Against <saved file>` reports semantic MATCH for kid, algorithm, public key and status. For exact artifact equality, separately compare the SHA-256 of the saved file and `dist/.well-known/truerolls-keys.json` |
| G6 PC off | With `docker @Beta stop api`, the site loads, shows the API as unavailable, and an old receipt still verifies |
| G7 reboot | After a reboot and sign-in, the stack is healthy within 3 minutes with no commands |
| G8 refusal | The production profile refuses the published test signer with this configuration |
| G9 remote CI | The deployed commit has green remote CI |

## Operating

```powershell
docker @Beta ps
docker @Beta logs --since 1h api
docker @Beta stop
docker @Beta up -d --wait
```

`restart: unless-stopped` brings the containers back when Docker Desktop starts. `docker @Beta down`
removes the containers but keeps the data volumes. Never add `-v` unless you intend to delete every
receipt and transcript.

To deploy a new commit: build and tag its image (step 3), set `KD_API_IMAGE`, run
`docker @Beta up -d --wait`, then rebuild the site and key set (step 5) and redeploy the Worker.
Roll back by pointing `KD_API_IMAGE` at the previous tag.

## Keys

The beta uses the single-key `KD_SIGNING_ED25519_SECRET` / `KD_SIGNING_KID` pair. Rotating or
revoking means moving to `KD_SIGNING_KEYS` as [Key Rotation And Revocation](key-rotation.md)
describes, which replaces those two variables in `infra/docker-compose.beta.yml`, and then
republishing the static key set with `scripts/beta-keyset.ps1`. On suspected compromise, stop
minting first: `docker @Beta stop cloudflared api`.

## Backups

Postgres and the MinIO bucket together are the receipt record; back them up as one recovery point
and rehearse a restore before inviting testers. Redis holds only locks and the mint-cap window;
after losing it, keep minting stopped for one full cap window (3600 s).

```powershell
pwsh -NoProfile -File scripts/tests/beta-ops.tests.ps1
pwsh -File scripts/beta-backup-restore.ps1 -ConfirmSourcePause `
  -BackupDirectory "$env:LOCALAPPDATA\TrueRolls\beta-backups\<new-unique-directory>"
```

The source stack must already exist. The backup command pauses its API while taking the database
and object snapshot, then restores its prior running state even on failure. If the source API is
already stopped, pass `-KeySetFile <saved issuer key set>`; it will remain stopped afterward.

Backups include the env file and issuer key set, so they must stay outside the repository and build
context. A new backup directory gets owner-only access; an existing directory is never overwritten.
These local permissions are not disk encryption or an offline backup. The owner must retain a
protected offline copy of the secrets and recovery data.

Restoration uses a unique `truerolls-beta-restore-<12 hex>` project, immutable source image IDs,
new volumes and networks, no host ports, and no cloudflared service regardless of inherited profiles
or tunnel tokens. It compares database row/sequence fingerprints, object names/hashes and the issuer
key set, then removes only label-checked restore resources. Source volumes are never deleted.
The protected backup directory is retained with `result.json` only after all checks and cleanup
succeed. This rehearsal is not permission to overwrite the real beta during disaster recovery.

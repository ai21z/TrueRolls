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
  |-- beta.truerolls.dev/livez    -> no Worker -> Cloudflare Tunnel
  |-- beta.truerolls.dev/healthz  -> no Worker -> Cloudflare Tunnel
  v
cloudflared (outbound only) -> api:8080 -> postgres, redis, minio    Compose project truerolls-beta
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
  entry point. A request without that header is refused.

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

### 6. Cloudflare

You do these steps yourself, signed in to your own account.

1. Zero Trust > Networks > Tunnels: create a remotely managed tunnel `truerolls-beta` with public
   hostname `beta.truerolls.dev` and service `http://api:8080`. Paste its token into `TUNNEL_TOKEN` in
   the env file, set `COMPOSE_PROFILES=tunnel`, and run `docker @Beta up -d --wait` again.
2. Zero Trust > Access > Applications: a self-hosted application for the whole hostname
   `beta.truerolls.dev`, login method one-time PIN, one Allow policy "Include: Emails" listing the
   testers, session duration 24 hours.
3. Workers: deploy `services/loom-demo` with Wrangler (`wrangler.jsonc` there). In the zone's Workers
   Routes, add `beta.truerolls.dev/v1/*`, `beta.truerolls.dev/livez` and `beta.truerolls.dev/healthz`
   with Worker "None"; these more specific routes send API traffic past the Worker to the tunnel.
4. Security > WAF: a rate-limiting rule on `/v1/roll`, and bounds on `/healthz` and
   `/v1/drand/health`, which the API leaves unthrottled.

### 7. Acceptance

| Gate | Check |
| --- | --- |
| G1 routing | An `/assets/` file comes from the Worker; `/livez` reaches the API; an unknown path gets the site |
| G2 Access | A signed-out request goes to the Access login; an email not on the list is refused |
| G3 client IP | API logs show your public IP, not a Cloudflare address |
| G4 roll | A live roll returns a `truerolls-drand-1` receipt that the browser verifies |
| G5 key set | `scripts/beta-keyset.ps1 -Check -Against <file saved from the browser>` reports MATCH |
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

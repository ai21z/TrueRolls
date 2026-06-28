# TrueRolls v2 - Strict Fair Mode (protocol & threat model)

> **STATUS: DRAFT / PROPOSED - NOT IMPLEMENTED.** This is a design document for review and
> external audit, not a description of shipping behavior. The current product is v1
> (signed receipt + deterministic replay); see [../threat-model.md](../threat-model.md) for what
> v1 does and does not prove. Nothing here may be presented to users as a live guarantee
> until it is built, the witness set is real, and the timing argument has been reviewed.
>
> **Default tier = Strict Fast; fallback/audit tier = Strict Conservative (§5).** Strict Fast's
> public fairness claim is **gated on a real, independent reactive witness policy** - until that
> exists, prototype with local/dev witnesses and keep public claims **off**.
>
> Three load-bearing items remain **open** (§9): (a) the independent **witness set/policy** and its
> independent publication root, (b) measured beacon-frontier timing (`Δ`, server-vs-witness drand-view
> skew), and (c) the implementation/audit of the pinned verifier trust roots. Do not claim
> "provably fair" before all close.

---

## Build checklist - from design to a defensible 9

**Where this stands:** the *design* is complete (this document). *Implementation has not started*;
v1 (signed receipt + replay, ≈6) is what ships today. The path below is ordered by leverage, not by
section number. **No public "provably fair" / fairness claim until the witnesses are real and the
audit is done** (§9.1, §11).

**Design - REVISED AFTER RED-TEAM:** threat model (§1) · protocol + epoch scheduler + lifecycle
(§3) · the two timing bounds (§4) · timing profiles (§5.2) · witness policy (§5.3) · dispute
evidence (§5.4) · verifier procedure (§6) · receipt schema (§7). Structural red-team fixes now
include pinned verifier trust roots, beacon-frontier witness attestations, fair-mode anti-downgrade,
manifest availability in the verifier path, signer-key binding, and monitor-scoped global checks.

**Operational - the load-bearing gap (no fairness claim without this):**
- [ ] Recruit `n` genuinely **independent reactive witnesses** - distinct operator / infra / ASN /
  jurisdiction, no TrueRolls control; publish the roster through an independently witnessed policy
  root and pin its `policy_hash` (§5.3).
- [ ] Stand up ≥1 **independent monitor** running the four invariant checks (no forks · one commit
  per epoch · token-bearing rolls included · no inconsistent checkpoints) (§5.3, §5.4).
- [ ] Choose the launch tier (Fast B default / Conservative fallback, §5.2).

**To pin (small, but blocking the numbers):**
- [ ] **Measure** the window budget (σ-fetch from a Worker · witness drand-frontier fetch ·
  reactive-cosign RTT · beacon-view skew) → fix `E`/`Δ` and the acceptance deadline (§5.2, §9.2).
- [ ] Define **miss-handling**: re-target a later `Rₑ` *with fresh witnessing*, never a silent
  extension (§5.2).
- [ ] `deadline_policy` string semantics + manifest delivery at scale (§9.8).
- [ ] HKDF key-schedule review vs RFC 5869 domain separation (§9.3).

**To build:**
- [ ] Cloudflare-Workers persistence for the Merkle log + checkpoint history (D1 / R2 / Durable
  Objects) (§9.4).
- [ ] `kd-receipt` v2: signer + the **single shared verifier** (§6), compiled to CLI + WASM.
- [ ] Golden + replay tests for the whole v2 chain (§9.6).

**To certify (converts *claimed* trust into *earned* trust):**
- [ ] **External audit** of this protocol - the tlock library audit does not cover it (§9.7).

**Honest score gates:** v1 ≈ **6** → with real independent witnesses + independent policy
publication + measured beacon-frontier timing + the witnessed anchor live ≈ **8.5** → + reference
verifier + this written threat model + external audit ≈ **9-9.5**.
**There is no trustless 10** - the drand `>½`-of-n threshold, the `k-of-n` witness quorum, and
no-post-quantum are *disclosed, irreducible* assumptions (§10).

---

## 0. What v2 adds over v1

v1 proves **replay** - re-derive the draw → face → metrics and check the Ed25519/JCS signature.
It does **not** prove the server chose the seed fairly: the server derives the seed and signs
*after* seeing the outcome, so it can **grind** (publish a favorable seed) or **withhold** (last-look).

v2 is designed to close that gap by making the seed come from a **future public beacon the server cannot
predict at commit time**, and by **publicly committing** the batch *before* that beacon resolves,
to an anchor where **backdating and equivocation are detectable**. Under the stated assumptions,
v2 closes **single-candidate grinding, withholding, backdating, and equivocation**; tlock optionally adds
**pending-privacy / anti-front-running**. It does **not** reach a literal "trustless 10" - see §10.

---

## 1. Adversary model

The **server is the adversary** (it builds the batch and already knows every roll's contents -
encrypting the manifest does **not** hide contents from the builder). A malicious server wants to:

| # | Attack | v2 mechanism that closes it |
|---|---|---|
| A | **Single-candidate grind** - try seeds, publish a favorable outcome | seed = f(future drand `σ_R`) and commit witnessed before `R` (§4; §5.2) |
| B | **Withhold / last-look** - suppress an unfavorable result | committed manifest is publicly recoverable after R and was anchored pre-R → anyone recomputes (§3.5) |
| C | **Backdate** - commit a favorable `batch_root` after learning σ_R, claim it predated R | lower bound binds the *verifiable* `σ_{R'}`; upper-bound evidence + the measured beacon-skew assumption place the commit **before R** (§4; §1 assumption 5) |
| D | **Equivocate / split-view** - show different roots to different users | **k-of-n independent witness** cosignatures (§4) |
| E | **Front-run** - act on knowledge of pending-but-unresolved rolls | *optional* tlock-encrypted manifest (§2.3) |
| F | **Game batch boundaries** - open/close batches opportunistically | **fixed epoch scheduler** keyed to drand rounds (§3.1) |
| G | **Selective non-inclusion** - drop a specific player's accepted roll | signed **pending-acceptance token** makes omission *provable misbehaviour*; without one, omission is DoS, not cheating (§3.2) |
| H | **Silent downgrade** - answer a fair-mode request with v1 / no v2 evidence | non-v2 responses fail v2 verification (check 1); accepted rolls bind the mode via the server-signed acceptance token (§3.2); the unsigned request does not prove to third parties that v2 was demanded |
| - | **Multi-candidate grinding** | detected by independent monitors enforcing one commit per epoch (§5.3, §5.4); a single receipt alone cannot prove global uniqueness |
| - | **Stall** (liveness) | objective, pre-committed multi-beacon fallback is still open (§9 item 9); until then, stalls are a liveness gap, not a closed fairness property |

**Assumptions (state these in every claim):** (1) drand `σ_R` is unpredictable to the *committer*
at commit time - i.e. the drand threshold is not compromised in the server's favor; (2) the verifier
pins, **outside** the receipt, the drand chain, the required version, and the single canonical policy
(§5.1, frozen by `policy_hash`, which fixes the witness roster, monitor policy, signer schedule, log
origin, and beacon-frontier); (3) those pinned policy roots are obtained from an
independently witnessed / externally governed publication channel, not from the server being
verified; (4) the witness **k-of-n quorum** is not colluding with the server and follows the
beacon-frontier policy in §5.2; (5) measured server-vs-witness drand-view skew stays below the policy
budget, so a server cannot see `σ_{Rₑ}` materially before a witness quorum refuses further
epoch-`e` signatures; (6) at least one honest witness/monitor view is reachable by public monitors;
(7) the off-chain `kd-core` engine's deterministic replay is correct (a separate property from the
anchor); (8) no post-quantum adversary.

---

## 2. Primitives

### 2.1 Entropy - drand quicknet (settled)
Unchained threshold-BLS beacon, scheme `bls-unchained-g1-rfc9380`, 3 s period, chain hash
`52db9ba7…84e971` (**pin and monitor it**). `randomness_R = SHA-256(σ_R)`. Worst-case collapse
under near-total collusion is *predict*, never *bias* - but anti-grinding still rests on
**σ_R being unpredictable to the committer at commit time**. Verify σ_R statelessly against the
pinned group public key. The threshold is a `>½`-of-n quorum; do **not** publish a specific count
as current (the `/info` endpoint does not expose it).

### 2.2 Anchor - RFC 6962 log + witness quorum (proposed)
A self-run RFC 6962 Merkle log of batch commitments, made trustworthy **not** by the server's
signature but by a **quorum of independent third-party witnesses** (C2SP `tlog-witness`) that
cosign a checkpoint only after verifying its append-only consistency proof. A server-signed-only
log is worthless: non-equivocation **cannot** be done by the operator alone. The verifier must pin
`policy_id -> policy_hash -> roster/config` out-of-band; a receipt that names a different witness
policy is **not** valid. That pin is not magic: if TrueRolls alone publishes the roster, users are
trusting TrueRolls to publish an honest roster. A public fairness claim requires the policy root to
be distributed through an independently witnessed / externally governed channel (for example a
policy transparency log with independent witnesses, an external governance process, or a public
ledger anchor). Optional **periodic** on-chain anchor of the batch log root (OpenTimestamps/Bitcoin
or an L2/DA layer) remains an escalation tier.

### 2.3 Privacy - tlock (OPTIONAL, not a fairness primitive)
tlock encrypts the manifest to round R so the public can't read pending contents until R. It adds
**privacy / anti-front-running only**. It does **not** close grinding or withholding (the anchor
does) and does **not** hide contents from the server. Use it solely when pending roll contents
must stay private until resolution.

### 2.4 Reused v1 stack (settled)
JCS / RFC 8785 canonicalization; Ed25519 receipt signatures; the pure `kd-core` engine
(κ∈[-1,1], KL+EV caps, prefix-CDF sampling); the single shared `kd-receipt` verifier (CLI + WASM).

### 2.5 Verifier trust roots (pinned, independently published, not receipt-chosen)
The verifier pins **three layers**, all obtained from an independently witnessed / externally
governed channel - never from the server being verified:

1. **External roots** (not TrueRolls-authored): the accepted protocol version `truerolls-v2-strict`,
   and the drand `chain_hash`, scheme, public key, period, genesis.
2. **`policy_hash`** = `SHA-256(JCS(truerolls_policy_body))` - freezing the **single** canonical
   TrueRolls policy (§5.1). `truerolls_policy_body` nests `witness_policy`, `monitor_policy`,
   `signer_schedule`, `log`, `beacon_frontier`, `epoch`, and optional `fallback`. There is **one**
   definition (§5.1); no field is pinned both inside and outside it.
3. **`publication_proof`** - evidence that this `policy_hash` was visible in an independently
   witnessed policy log / external governance channel **before** any receipt relied on it. It is a
   layer *outside* the hashed body (it references `policy_hash`, so it cannot live inside it).

A server-fetched runtime config is not sufficient: if the only publication path is a
TrueRolls-controlled endpoint, the protocol has not escaped "trust TrueRolls to publish an honest
policy." The receipt may repeat `policy_id`/`policy_hash` for auditability but cannot introduce them.
If the receipt's version, drand chain, or `policy_hash` differs from the pinned roots, verification
fails before any cryptographic replay.

---

## 3. Protocol flow

### 3.1 Epoch scheduler (fixed - no server-chosen boundaries)
Batch boundaries are a deterministic function of the drand round schedule, **not** of server
choice (otherwise the server could open/close batches opportunistically - attack F). Public
params, pinned in the verifier trust roots and witness policy (§2.5, §5.1):

- `E` - epoch length, in drand rounds.
- `Δ` - reveal gap, in drand rounds (≥ the tier minimum, §5).
- drand `genesis` + `chain_hash` - the round↔time schedule is public.

Epoch `e` collects rolls **accepted** while the current drand round ∈ `[e·E, (e+1)·E)`. Its
**lower-bound round** is `R'ₑ = (e+1)·E` (the epoch boundary); its **reveal round** is
`Rₑ = R'ₑ + Δ`. All of `e`, `R'ₑ`, `Rₑ` are fixed by `(E, Δ, genesis)` and a roll's acceptance
round - the server cannot choose them. A roll accepted in epoch `e` MUST be committed in batch `e`
or rejected; it cannot be slipped into another batch. Each `precommit_payload_i` records its
`accept_round` - a signed server commitment via the acceptance token (§3.2) - which the verifier
checks lies in `[e·E, (e+1)·E)`.

### 3.2 Roll lifecycle & accepted-roll evidence

A roll moves through four distinct states (S1-S4); the protocol must not blur them:

- **S1 · Submitted** - the player sends a roll request with
  `{ request_mode:"truerolls-v2-strict", client_nonce, roll_id, ... }`. The client nonce makes the
  request replay-resistant inside the protocol. Unless the request is client-signed or externally
  logged, it does **not** cryptographically prove to third parties that the player demanded v2; it
  only makes a v1/no-evidence response fail v2 verification. If the server answers this request with
  a v1 receipt or no v2 evidence, that is a **downgrade/refusal/DoS**, not a valid fair-mode
  settlement.
- **S2 · Accepted** - the server returns a signed **pending-acceptance token**:
  ```
  pending_acceptance = server_sig({
    v:"truerolls-v2-acceptance",
    request_mode:"truerolls-v2-strict",
    roll_id, client_nonce, precommit_payload_hash,
    accept_round, epoch, deadline_policy,
    policy_id, policy_hash,
    signer_kid
  })
  ```
  with `precommit_payload_hash = leaf_i`. The token is the player's **non-repudiable** proof that
  the server committed to include this exact payload in epoch `e` by `deadline_policy` (e.g.
  "in batch `e`, whose commit is logged + witnessed before round `Rₑ`"). It also turns
  `accept_round`, `request_mode`, and the witness policy into signed **server commitments**, not
  self-asserted payload fields.
- **S3 · Included** - `leaf_i` appears under `batch_root` (provable via `batch_inclusion_proof`,
  verifier check 5), and the token's `precommit_payload_hash` matches it.
- **S4 · Resolved** - at round `Rₑ` the outcome is derived and the receipt (§3.5) is issued.

**Accountability boundary - state it plainly.** The token closes the gap between *accepted* and
*included*: if the server issued a `pending_acceptance` for a roll that is then **absent** from
batch `e` (provable from the anchored manifest / the log), the player can **prove server
misbehaviour** (signed acceptance + public non-inclusion). **Without** a token (or equivalent public
manifest evidence of acceptance), selective non-inclusion is indistinguishable from "never received"
- it is **denial of service, not cryptographic cheating**. A server **refusing to accept** at all
(issuing no token) is likewise pure DoS: symmetric, and unable to favour outcomes because the future
seed `σ_{Rₑ}` is unknown at acceptance. The residual here is **availability, not fairness**.

Delivery: evidence may be **player-held** (the token, matched to the receipt's `leaf_i`) or
**public** (the anchored manifest enumerates the accepted `precommit_payload_hash` set for epoch
`e`). The player-held token is what makes *non-inclusion* provable; the public manifest proves the
*composition* of what was included.

### 3.3 Commit (at boundary `R'ₑ`, finalized before reveal `Rₑ`)
1. Accept strict-v2 rolls into epoch `e`. For each:
   `leaf_i = SHA-256(JCS(precommit_payload_i))`, where
   `precommit_payload_i = { request_mode, die, kappa, roll_id, client_nonce, accept_round, … }` -
   **no** seed/outcome.
2. The `manifest` is `{ entries: [ { leaf, precommit_payload } ] }`; each entry carries the full
   `precommit_payload_i`, so any verifier can recompute `leaf = SHA-256(JCS(precommit_payload))` and
   read `accept_round` (check 5). `batch_root = MerkleRoot(canonical_manifest_leaves)` (RFC 6962
   hashing) over **exactly** that set, entries sorted lexicographically by the 32-byte `leaf` value
   (ascending unsigned byte order; ties are impossible if `roll_id`/`client_nonce` are unique). The
   manifest is *authoritative for membership* - what makes non-inclusion provable (§5.4). Insertion
   order is not allowed to define the root.
3. Once round `R'ₑ` resolves, fetch `σ_{R'ₑ}` and bind the **real beacon value** (not just the
   round number - a bare integer proves nothing) as the lower bound:
   ```
   lower_bound = { round: R'ₑ, sigma_R_prime, randomness_R_prime, chain_hash }
   ```
   `σ_{R'ₑ}` is used **only** as a verifiable lower-bound timestamp; it is **not** in the seed path.
4. Build the commitment body, sign it, then log the signed commitment:
   ```
   commit_body = {
     v:"truerolls-v2-strict", epoch: e, batch_root,
     lower_bound,                      # verifiable σ_{R'ₑ} binding
     target_round: Rₑ,              # must equal deterministic (e+1)·E + Δ
     manifest_hash,
     manifest_evidence: { mode, public_manifest? | tlock_ciphertext, tlock_params? },
     policy_id, policy_hash,         # names the single pinned policy (§5.1); it fixes log, monitor, signer schedule, fallback
     signer: { signer_kid, public_key }
   }
   server_sig = Sign(signer_kid, JCS(commit_body))
   commit = { body: commit_body, server_sig }
   ```
   Default `manifest_evidence.mode` is `"public"` and `public_manifest` must be available to
   verifiers. The tlock variant carries `tlock_ciphertext`, `tlock_params`, and `manifest_hash`;
   after `Rₑ`, the decrypted manifest becomes verifier input. If the public manifest (or decrypted
   tlock manifest) is unavailable or fails `H(JCS(canonical_manifest)) == manifest_hash`, receipts for
   the batch are invalid/void.
5. Append `commit` (as `commit_leaf = SHA-256(JCS(commit))`) to the transparency log; obtain a
   **checkpoint** and **k-of-n witness cosignatures** over it under the pinned policy. Each witness
   cosignature includes the witness's independently observed drand frontier (§5.2); a wall-clock
   timestamp alone is not acceptable upper-bound evidence.

### 3.4 Reveal (at round `Rₑ`)
6. Fetch `σ_{Rₑ}`; verify it against the pinned drand group/chain hash; `randomness_R = SHA-256(σ_{Rₑ})`.
7. For each roll: `seed_i = HKDF-SHA256(IKM = randomness_R, salt = batch_root,
   info = JCS(["truerolls-v2-strict", chain_hash, epoch, Rₑ, roll_id, leaf_i]))`.
   *(IKM is the published `randomness_R` for off-the-shelf drand verifiability. Secrecy-before-R
   comes from `Rₑ` being in the future - and from tlock in private mode - **not** from HKDF, since
   `randomness_R` is public the instant `Rₑ` settles. The exact key schedule is an open review item, §9.)*
8. Run `kd-core(die, kappa, seed_i) → outcome_i`. **Anyone** can recompute this from public inputs.

### 3.5 Receipt v2
9. Emit a receipt per roll carrying the v1 result fields **plus** the anchor evidence (§7), so a
   verifier can confirm the whole chain offline. Because the manifest was public (or publicly
   recoverable after `Rₑ` in the tlock variant) and anchored pre-`Rₑ`, a withheld receipt is moot -
   the outcome is publicly derivable.

---

## 4. The two timing bounds (the crux of anti-backdating)

Proving "`batch_root` was committed before round `Rₑ`" needs **both** bounds. Neither alone suffices.

- **Lower bound - bind the *value*, not the number.** `commit.lower_bound` carries
  `{R'ₑ, σ_{R'ₑ}, randomness_{R'ₑ}, chain_hash}`, and the verifier **verifies `σ_{R'ₑ}`** against the
  pinned group key. Because `σ_{R'ₑ}` does not exist before round `R'ₑ`, the commit provably
  incorporates round-`R'ₑ` beacon output → it could not have been *built* before `R'ₑ`. (Recording
  only the integer `R'ₑ` would prove nothing - a backdater writes any old number after the fact.)
- **Upper bound - NOT free.** `σ_{R'ₑ}` is public after `R'ₑ`, so a backdater could still copy it
  into a payload after `Rₑ`; the lower bound alone does not stop backdating. The upper bound - proof
  the commit was *logged* before `Rₑ` - must come from one of:
  1. a **reactive** witness quorum that cosigns the checkpoint while each witness's independently
     observed drand frontier is still **before** `Rₑ` (Strict Fast);
  2. a witness **beacon-frontier freshness policy** + conservative `Δ` (Strict Conservative);
  3. an **external** chain-block / timestamp ordering whose time precedes `Rₑ`.
- **`Δ` is the latency dial.** Small `Δ` closes **grinding** (`σ_{Rₑ}` unknown at commit).
  Third-party-provable **anti-backdating** requires `Δ` to exceed the chosen upper-bound mechanism's
  timing resolution.

**Wall-clock timestamps are telemetry, not proof.** A lagging witness clock can make a late signature
look early. Strict Fast therefore relies on a **beacon-frontier attestation**: every accepting witness
signs `(checkpoint, commit_leaf, observed_drand_round, observed_sigma, observed_chain_hash)` after
independently querying/subscribing to drand, and the verifier accepts only if the observed beacon
round is `< Rₑ` under the pinned policy. This does not remove trust in witnesses; it narrows the trust
claim to "a quorum did not sign after its own drand view reached `Rₑ`." If a server can see `σ_{Rₑ}`
materially before a witness quorum can observe `Rₑ` and refuse, Strict Fast is unsafe. That
beacon-view skew is what the measurement prototype must quantify.

**Equivocation (D)** is orthogonal to timing and is closed by the **k-of-n witness quorum** only
against the pinned policy: an attacker cannot make a user accept an unlogged/forked root unless it
controls more than the threshold of independent witnesses; below threshold it can only deny service.

---

## 5. Tiers, witness policy & dispute evidence

**Decision:** default = **Strict Fast**; fallback / audit / high-assurance = **Strict Conservative**.
Strict Fast is only meaningful with a *real* reactive witness policy (§5.1) - without it, "seconds"
is optimistic copy. Until the policy is real and independent, prototype with local/dev witnesses and
keep public fairness claims **off**.

| | **Strict Fast (default)** | **Strict Conservative (fallback)** |
|---|---|---|
| Upper-bound mechanism | **Reactive beacon-frontier** witnessed checkpoint quorum (log requests cosignatures during checkpoint production; witnesses attest their latest observed drand round) | **Polling beacon-frontier** witnesses, and/or a **periodic on-chain** checkpoint |
| `Δ` | small - cover log integration + witness round-trip; **plausibly seconds** | **minutes** (Sigsum polls ≥1/min; cosigned heads 5-10 min) |
| Trade-off | best UX; **operationally sensitive** - needs reactive witnesses + an explicit drand-frontier policy | simpler, robust; worse UX |
| Honest caveat | seconds-scale is *reported* (Valsorda sub-second added latency; Rekor v2 "a few seconds") but depends on the witness deployment you actually arrange | minutes-scale is well-understood and easy to defend |

Both tiers share one receipt schema and one verifier; only the upper-bound mechanism and `Δ` differ.

### 5.1 The canonical trust policy (`truerolls_policy_body`, frozen by one `policy_hash`)
There is exactly **one** policy object. `policy_hash` freezes its body; the publication proof is a
**separate outer layer** (it references the hash, so it cannot live inside it). A receipt names
`policy_id` + `policy_hash`; the verifier evaluates it only if both match its pinned roots (§2.5). A
receipt cannot choose its own roster. Until the policy is populated with **independent** operators
**and** published independently, no public fairness claim may be made.
```
truerolls_policy_body = {
  policy_id, version,
  witness_policy: {
    quorum: { k, n },                                # k-of-n required
    witnesses: [
      { key_id, public_key, endpoint, operator, mode: "reactive" | "polling",
        infra, jurisdiction, valid_from_epoch, valid_to_epoch }
    ],
    beacon_frontier: {
      required: true,
      frontier_freshness_window_rounds,
      measured_server_witness_skew_bound,
      measurement_report_hash,
      clock_timestamp: "telemetry_only"
    }
  },
  monitor_policy:  { monitor_roster, log_scan_rules },
  signer_schedule: [ { signer_kid, public_key, valid_from_epoch, valid_to_epoch } ],  # non-overlapping; exactly one active signer per epoch
  log:             { origin, public_key },           # the only accepted batch log
  epoch:           { E_rounds, delta_rounds },       # the fixed scheduler params (§3.1)
  tier:            "strict_fast" | "strict_conservative",
  fallback?:       { beacon_fallback_policy_hash }
}

policy_hash       = SHA-256(JCS(truerolls_policy_body))            # NOT a member of the body
publication_proof = { policy_log_origin, policy_log_checkpoint, external_anchor? }  # OUTER layer; references policy_hash
```

The `publication_proof` is load-bearing and lives **outside** `policy_hash`: it must prove the hash
was visible in an independently witnessed policy log / external governance channel before any receipt
relied on it. If the only publication path is a TrueRolls-controlled endpoint, the protocol has not
escaped "trust TrueRolls to publish an honest policy." Note: `drand` chain params and the accepted
version are **external roots** pinned separately (§2.5), **not** inside `truerolls_policy_body`.

### 5.2 Candidate timing profiles & the "logged before `Rₑ`" argument

`round = 3 s`. The **witness window** - fetch `σ_{R'ₑ}`, build + log the commit, have witnesses
fetch/observe their own drand frontier, and collect `k-of-n` cosignatures - is `Δ` rounds. Per-roll latency ≈ `Δ` rounds (a roll that
arrives just before the boundary) up to `(E+Δ)` rounds (a roll at the epoch's start); average
≈ `(E/2 + Δ)`.

| Profile | `E` (rounds) | `Δ` (rounds) | Witness window | Roll latency | Witness mode |
|---|---|---|---|---|---|
| **Fast A** | 1-2 | 2-4 | 6-12 s | 6-18 s | **reactive**, tight beacon-frontier SLA |
| **Fast B** | 3-5 | 3-6 | 9-18 s | 9-33 s | **reactive**, more slack |
| **Conservative** | ~20 (≈60 s) | ~100-200 (5-10 min) | minutes | minutes | **polling** + periodic chain anchor |

**Window budget (estimates - MEASURE before fixing numbers):** fetch `σ_{R'ₑ}` ~0.1-0.5 s · build +
sign + log-append ~0.05 s · witness independent drand-frontier fetch/subscription check
~0.1-1.0 s · `k-of-n` reactive cosign (parallel, wait for the k-th) ~0.3-1.5 s · beacon-view skew
margin ~0-1 round. Critical path is likely **1-5 s**, but the real risk is not average RTT; it is
whether the server can obtain `σ_{Rₑ}` before a witness quorum's drand frontier reaches `Rₑ`.
`Δ=1` round (3 s) is too tight; **`Δ≥2` rounds is only a starting floor** for reactive Fast mode.

**"Logged before `Rₑ`" - reactive (Fast A/B).** In the window `[R'ₑ, Rₑ)` the server appends the
commit and requests cosignatures *synchronously*. Each honest witness independently queries or
subscribes to drand, verifies the log consistency proof, and signs:
```
witness_cosignature_payload = {
  checkpoint_hash, commit_leaf,
  observed_drand: { round, sigma, chain_hash },
  policy_id, policy_hash
}
```
and `witness_signature = Sign_witness_key(JCS(witness_cosignature_payload))`. The payload is bound
to this exact checkpoint and commit leaf; a signature over only the checkpoint, or over fields chosen
by the receipt, is not sufficient.

The verifier requires `k` cosignatures from distinct pinned-policy witnesses, each with valid
`observed_drand.sigma` and `Rₑ - s <= observed_drand.round < Rₑ`, where `s =
frontier_freshness_window_rounds` from the pinned policy (Strict Fast usually starts with `s=1`).
An honest witness must refuse to sign this epoch once its own drand frontier has reached `Rₑ` or
later.
Therefore a late server can pass verification only by colluding with `k` witnesses **or** exploiting
a quorum whose drand view lags behind the server's view enough to create last-look. That lag is a
security parameter, not a UX metric.

The lower bound `σ_{R'ₑ}` confines the whole operation to the `Δ`-round window and forces every
candidate commit into the **public** log. It does **not** let a single receipt prove no other commit
for the same epoch exists; that global uniqueness invariant is monitor-enforced (§5.3, §5.4).

**"Logged before `Rₑ`" - Conservative.** Witnesses **poll** (≥1/min) and cosign fresh heads with
their observed drand frontier. Because polling + freshness is coarse, `Δ` must exceed
`poll_interval + freshness_window + beacon_view_skew_margin` → **minutes**. A **periodic on-chain
anchor** of the log root is the T2 backstop (not the per-batch timer): Bitcoin block timestamps
carry ~±2 h consensus slop, so a chain is a coarse *periodic* backstop, **not** a tight per-batch
"before-`Rₑ`" clock; an L2/DA layer with fast objective finality could serve if you accept a chain
dependency.

**Honest core - the upper bound is irreducibly a trust claim.** drand gives the lower bound
(`≥ R'ₑ`) cryptographically and for free. The upper bound ("logged before `Rₑ`") **cannot** be made
purely cryptographic: proving "X happened before a future event became available to the committer"
requires third-party witnesses whose beacon view is not materially behind the committer's. That
attestation is the `k-of-n` witness quorum (or a chain); its strength is exactly the independence,
honesty, and drand-frontier freshness of that quorum. **There is no witness-free upper bound** -
design around that, don't paper over it.

**Failure modes.**
- **Witness-latency miss (reactive):** fewer than `k` cosignatures arrive before witnesses observe
  `Rₑ`. This is a **liveness** failure, not a fairness break. Handling: abort the batch and re-issue
  its rolls into a later epoch, or re-target a later `Rₑ` **with fresh witnessing** (never silently
  extend - an unwitnessed extension reopens backdating). Tight `Δ` (Fast A) raises the miss rate.
- **Beacon-view skew:** if the server sees `σ_{Rₑ}` before a quorum witnesses' drand frontier reaches
  `Rₑ`, the server can last-look while obtaining verifier-valid `<Rₑ` witness attestations. This is
  the central Strict Fast risk. Mitigate with independent low-latency drand subscriptions in every
  witness, a measured skew budget, and a conservative `Δ`; if measurement cannot bound this, use
  Conservative or on-chain fallback.
- **Clock skew:** wall-clock timestamps remain useful for operations and dispute triage, but they are
  not verifier proof. A bad clock can cause noisy telemetry; it must not by itself validate or void a
  batch.
- **Witness-quorum collusion:** if a colluding set can forge `k` backdated cosignatures, the
  before-`Rₑ` claim breaks. This is the §1 boundary; escalate to T2 (periodic chain anchor).
- **Conservative - poll/finality lag:** a head not yet polled, or an anchor block not yet final, when
  `Rₑ` passes. Absorbed by the minutes-scale `Δ`; the cost is UX - hence audit/high-stakes mode.

**What each profile DEMANDS of the witness set (the input to §5.1 / §9.1):**
- **Fast A** - witnesses MUST support **reactive** cosigning (synchronous `tlog-witness`), low RTT,
  independent low-latency drand frontier checks, and a quorum response in ~1-3 s. Most demanding to source.
- **Fast B** - same reactive requirement, looser SLA (higher RTT / slower witnesses / beacon-view
  skew to a few seconds). Easier to source while staying live. **Recommended launch default.**
- **Conservative** - **polling** witnesses (Sigsum-style) and/or a periodic chain anchor; no tight
  SLA, existing infra patterns apply. Easiest, but minutes of latency - the audit/high-stakes fallback.

### 5.3 Witness policy (design)

Target derived from §5.2 (launch default = Fast B): **reactive** witnesses with independent,
low-latency drand frontier checks and a quorum that answers within ~1-2 s.

**Quorum `k/n`.** The verifier accepts only `k` cosignatures from distinct roster witnesses.
- *Security (equivocation):* an honest witness cosigns only one consistent chain, so forging a split
  view requires `k` **colluding** witnesses → higher `k` = stronger.
- *Liveness:* the server needs `k` responses inside the `Δ` window → it tolerates `n − k` slow/down
  witnesses.
- **Recommended start: `k=3, n=5`** (tolerate 2 down; need 3 to collude). Minimal viable: `k=2, n=3`.
  `k=1` is **forbidden** - a single witness is no independence and one bad clock/key breaks it.

**Operator independence (the load-bearing part).** "Independent" must be **auditable, not asserted**.
The published roster gives, per witness: operator identity, witness public key, endpoint, mode,
infrastructure + jurisdiction. The independence rationale must demonstrate **distinct operators,
distinct infrastructure (different cloud / ASN / jurisdiction), and no financial or operational
control by TrueRolls.** Honest caveat: if the witnesses share an operator or infra, or are all
TrueRolls-funded, "independent" is hollow and the fairness claim is void - fall back to Conservative
+ chain anchor, which shifts the trust onto the chain instead of the quorum.

**Mode & freshness (expressed in beacon rounds).** Fast tiers require **every** quorum witness in
**reactive** mode (synchronous C2SP `tlog-witness` add-checkpoint) and require the witness to include
`observed_drand` in the signed payload. The verifier requires
`Rₑ - frontier_freshness_window_rounds <= observed_drand.round < Rₑ` under the pinned policy. The
policy also carries `measured_server_witness_skew_bound` and `measurement_report_hash`; those are not
derived from one receipt, but they are the empirical gate for claiming Strict Fast. Conservative uses
**polling** with `max_staleness_rounds >= poll_interval + freshness_window` → minutes.

**Monitoring & dispute hooks.** Witnesses attest consistency + freshness **only - not content or
completeness**. So an independent **monitor** (ideally several) must continuously read the public log
+ all cosignatures and check: (a) append-only consistency / no forks for the pinned `log.origin`;
(b) **exactly one commit per epoch** (multi-candidate grinding); (c) every roll bearing a
`pending_acceptance` token appears in its epoch batch (non-inclusion); (d) the public/decrypted
manifest is available by the policy deadline; (e) no two inconsistent cosigned checkpoints
(equivocation). Any
violation yields publishable evidence → provable misbehaviour. These are **global log invariants**:
ordinary receipt verification does not prove "no other commit for this epoch exists" unless it is
also given a trusted monitor proof or a complete log scan over the relevant checkpoint range. The full
**dispute flow** is §5.4.

### 5.4 Dispute flow & evidence packages

Disputes are settled by **public re-verification, not a trusted arbiter**: every package below is
**self-contained** - it bundles the cryptographic artifacts so *anyone* can re-run the check and reach
the same verdict. Players hold their tokens + receipts; an independent **monitor** (§5.3) produces the
log-derived packages. The publication venue is secondary to re-verifiability.

**Proof of absence needs a non-membership artifact.** A `pending_acceptance` token plus "I don't see
my leaf" is a *claim*, not a proof. v2's default is the **public full manifest**: the epoch manifest
enumerates *all* accepted precommit payloads, `batch_root = MerkleRoot(sorted manifest leaves)`, and
`manifest_hash` is inside the witnessed `commit` - so "`L ∉ manifest`" **is** "`L ∉ batch_root`,"
publicly checkable. (Heavier alternatives - tlock-decrypted manifest after `Rₑ`, or a sorted-Merkle
accepted set with explicit non-membership proofs - are used only if pending-set privacy or manifest
size forces it.)

| # | Package | Artifacts | Check | Verdict |
|---|---|---|---|---|
| 1 | **Non-inclusion** | `pending_acceptance` token for `L`; the witnessed epoch-`e` `commit` (+ log-inclusion + `k-of-n` cosigs); the public/decrypted `manifest` | token sig valid & `accept_round ∈ [e·E,(e+1)·E)`; commit validly witnessed; `H(JCS(canonical_manifest))==manifest_hash` & `batch_root==MerkleRoot(canonical_manifest_leaves)`; **`L ∉ manifest`** | **server cheated** - accepted then excluded. *No token → only DoS.* |
| 2 | **Equivocation / split-view** | two checkpoints for the same pinned log origin, each with valid witness cosigs, mutually **inconsistent** (same `tree_size`, different `root_hash`; or no valid consistency proof) | both cosig sets verify under pinned policy keys; the two are inconsistent | **the log equivocated** - the witnesses that cosigned both inconsistent views are implicated (malicious or compromised) |
| 3 | **Multi-commit-per-epoch** | two distinct witnessed `commit`s both with `epoch=e` | both verify under the pinned policy; `epoch` equal; commits differ | **grinding attempt** - the one-commit-per-epoch invariant (§3.1) is violated. A single receipt cannot rule this out; monitors detect it. |
| 4 | **Missed-deadline / failed batch** | the epoch-`e` `commit` + all its witness attestations + `Rₑ` | fewer than `k` cosigs with valid `observed_drand.round < Rₑ` under the pinned policy | **batch void** - its receipts MUST be rejected at verifier check 8. *Liveness event, not cheating; stops a late server settling a now-grindable batch.* |
| 5 | **Tampered receipt / replay mismatch** | the receipt + public inputs (`σ_{Rₑ}`, payload, params) | re-run §6 - a failed inclusion / signature / replay check (`face`/`alpha`/`kl`/`ev`) | **receipt INVALID** - deterministic, self-contained, no token needed |
| 6 | **Missing batch / no valid commit** | monitor proof: a checkpoint range covering epoch `e`'s commit deadline, all commit leaves in that range, and witness cosigs for the range endpoints | no valid commit for `epoch=e` appears by the deadline under the pinned policy | **batch failed / DoS** - token holders can prove non-settlement, but not outcome cheating unless a later conflicting commit appears |
| 7 | **Manifest unavailable** | witnessed commit, manifest deadline, and failed public/tlock manifest retrieval evidence from monitors | `manifest_hash` is committed but no public/decryptable manifest is available by the policy deadline | **batch void / withholding event** - verifier rejects receipts; monitors make the failure public |

Packages 1 and 4 rest on the §1 assumptions: a token proves *acceptance*, the manifest proves
*composition*, and the witnessed log makes both non-repudiable. Package 2 is the transparency payoff -
equivocation is invisible in real time but **publicly provable after the fact**, which is the
deterrent. Packages 3, 5, 6, and 7 need no token at all.

---

## 6. Verifier procedure (drives the schema - not the reverse)

To accept a v2 receipt, a verifier (CLI / WASM / third party) checks, in order:

1. **Pinned trust roots / no downgrade** - receipt version is `truerolls-v2-strict`; the drand chain
   and `policy_id`/`policy_hash` match the verifier's pinned roots (§2.5). The verifier recomputes
   `policy_hash = SHA-256(JCS(truerolls_policy_body))` from the pinned policy and verifies the
   separate `publication_proof` (independent publication of that hash). The pinned policy fixes the
   log origin, witness roster, monitor policy, signer schedule, beacon-frontier params, and fallback -
   so no per-field hash is needed. A v1 receipt cannot satisfy this check.
2. **Reconstruct commit** - rebuild the exact `commit_body` from receipt evidence, including
   `epoch`, `batch_root`, `lower_bound`, `target_round`, `manifest_hash`, `manifest_evidence`,
   `policy_id`, `policy_hash`, and `signer`; rebuild `commit = { body: commit_body, server_sig }`;
   compute `commit_leaf = SHA-256(JCS(commit))`.
3. **Server signature + signer binding** - verify `server_sig` over `JCS(commit_body)`; verify
   `signer_kid/public_key` is the single active signer for `commit_body.epoch` under the pinned,
   non-overlapping signer schedule.
4. **Manifest availability + authority** - obtain the public manifest (or decrypt/verify the tlock
   manifest after `Rₑ` using the logged `tlock_ciphertext` + `tlock_params`); confirm
   `H(JCS(canonical_manifest)) == manifest_hash`, canonical leaf sort, uniqueness of
   `(roll_id, client_nonce)` within the manifest, and
   `batch_root == MerkleRoot(canonical_manifest_leaves)`. Missing/undecryptable manifest →
   INVALID/VOID.
5. **Batch inclusion** - `batch_inclusion_proof`: `leaf_i → batch_root` (the roll was in the batch);
   confirm `leaf_i = SHA-256(JCS(precommit_payload_i))`,
   `precommit_payload_i.request_mode == "truerolls-v2-strict"`,
   `precommit_payload_i.client_nonce == receipt.fair_request.client_nonce`, and
   `precommit_payload_i.accept_round ∈ [e·E, (e+1)·E)`.
6. **Log inclusion** - `log_inclusion_proof`: `commit_leaf → checkpoint.root_hash` (the batch
   commitment was in the pinned witnessed log origin).
7. **Witness quorum / non-equivocation** - `k-of-n` witness cosignatures over that checkpoint,
   against the pinned policy named by `policy_ref` (defeats split-view only under that policy). Each
   signature must verify over exactly `JCS(witness_cosignature_payload)`, **and** for each counted
   cosignature the verifier requires `payload.checkpoint_hash == SHA-256(JCS(checkpoint))`,
   `payload.commit_leaf == commit_leaf` (from check 2), and `payload.policy_id`/`payload.policy_hash`
   equal the pinned values - otherwise the cosignature binds a different checkpoint/commit/policy and
   is **not** counted.
8. **Upper bound** - every counted witness cosignature includes valid `observed_drand` evidence
   (`payload.observed_drand.sigma` verifies under the pinned drand chain and
   `Rₑ - frontier_freshness_window_rounds <= payload.observed_drand.round < Rₑ`). Wall-clock
   timestamps alone do not satisfy this check.
9. **Lower bound** - verify `σ_{R'ₑ}` against the pinned group key; confirm
   `randomness_{R'ₑ} = SHA-256(σ_{R'ₑ})`, that this exact value is the one inside the logged `commit`,
   and that `R'ₑ < Rₑ`.
10. **Epoch integrity** - `R'ₑ` and `Rₑ` are the deterministic `(E, Δ, genesis)` values for
    `commit_body.epoch`; `commit_body.target_round == Rₑ == receipt.drand.round` (no server-chosen
    boundary).
11. **Beacon** - `σ_{Rₑ}` verifies against the pinned drand group/chain hash;
    `randomness_R = SHA-256(σ_{Rₑ})`.
12. **Replay** - recompute `seed_i`, run `kd-core`, confirm `face`/`alpha`/`kl`/`ev` match within
    `1e-9`.
13. *(optional)* **Chain anchor** - verify the periodic on-chain anchor + a consistency proof from
    the anchored root to this checkpoint.

> *Player-side check (optional):* if the player presents a `pending_acceptance` token, verify the
> server signature, signer binding, `request_mode`, `client_nonce`, `policy_id`/`policy_hash`,
> `signer_kid`, and that `precommit_payload_hash == leaf_i` with matching
> `accept_round`/`epoch` - turning any
> non-inclusion of an accepted roll into provable server misbehaviour (§3.2).

`VALID` ⟺ all applicable steps pass. 1 fails → wrong trust root or downgrade; 2-7 fail →
tampering/equivocation/manifest failure; 8-10 fail → the ordering/anti-backdating proof is absent;
11-12 fail → the math/seed is inconsistent.

---

## 7. Receipt v2 field set (one field per verifier check)

```
receipt_v2 = {
  v: "truerolls-v2-strict",
  fair_request: { request_mode:"truerolls-v2-strict", client_nonce },                         # [check 1,5]
  # --- v1 result (unchanged) ---
  id, die, kappa, face, alpha, kl, ev, created_at,
  # --- epoch + seed provenance ---
  epoch: e,
  target_round: Rₑ,                                  # rebuilds commit_body; bound by [check 2,10]
  drand: { chain_hash, round Rₑ, sigma_R, randomness_R },
  derivation: {
    kdf:"HKDF-SHA256",
    ikm:"randomness_R",
    salt:"batch_root",
    info_encoding:"JCS-array",
    info:["truerolls-v2-strict", chain_hash, epoch, Rₑ, roll_id, leaf_i]
  },
  # --- anchor evidence ---
  anchor: {
    server_sig,                                                                                 # [check 3]
    manifest_evidence: {
      mode: "public" | "tlock",
      public_manifest?,        # = { entries: [ { leaf, precommit_payload } ] } - carries precommit_payload_i for check 5
      tlock_ciphertext?,
      tlock_params?,
      decrypted_manifest?      # same shape, available after Rₑ
    },                                                                                       # [check 4,5]
    manifest_hash,
    batch_root, leaf_index,
    batch_inclusion_proof[],        # leaf_i      -> batch_root            (roll in batch)   [check 5]
    log_inclusion_proof[],          # commit_leaf -> checkpoint.root_hash  (batch in log)    [check 6]
    checkpoint: { origin, tree_size, root_hash },
    witness_cosignatures[]: {
      witness_key_id,
      payload: {
        checkpoint_hash,
        commit_leaf,
        observed_drand: { round, sigma, chain_hash },
        policy_id,
        policy_hash
      },
      signature,
      timestamp?      # telemetry only
    },                                                                                       # [check 7,8]
    lower_bound: { round R', sigma_R_prime, randomness_R_prime, chain_hash },                # [check 9]
    chain_anchor?: { ref, anchored_root, consistency_proof[] }   # optional escalation       [check 13]
  },
  policy_ref: { policy_id, policy_hash },            # must match verifier-pinned policy (§5.1) [check 1,7]
  signer: { signer_kid, public_key },                # must match verifier-pinned schedule   [check 1,3]
  beacon_fallback_policy_hash?,
  # --- integrity ---
  # No envelope signature: v2 trust = commit.server_sig + k-of-n witness cosignatures + the beacon.
  # Every field above is independently verified, so the bundle needs no outer sig.
}
```

Two **separate** Merkle proofs - `batch_inclusion_proof` (roll → batch) and `log_inclusion_proof`
(batch → witnessed log) - are mandatory; conflating them is a verifier-confusion bug. The
`pending_acceptance` token (§3.2) is **player-held**, not part of the receipt; a player matches it to
the receipt via `leaf_i`, `client_nonce`, and `policy_hash`. The manifest is no longer merely
a dispute artifact; it is verifier input for every receipt.

---

## 8. Tier thresholds for the on-chain anchor

- **T1 - witnessed self-log only.** Sufficient when the adversary cannot collude with a witness
  quorum. The default.
- **T2 - + periodic on-chain anchor of the log root.** Add when you must survive *all* witnesses
  being unavailable/colluding, or want a publicly-objective backstop. Every batch stays bound via
  the log's consistency proof, so **per-batch** settlement is not needed.
- **T3 - per-batch on-chain settlement.** Only if the threat model assumes witness-quorum collusion
  **and** each batch must be independently anchored without trusting the log's consistency. Rarely
  justified for this product.

Any fallback or escalation path must be **pre-committed** in `beacon_fallback_policy_hash` before the
target round. A server-asserted "the primary stalled, so I switched entropy sources" after seeing an
outcome is a last-look switch, not a liveness fallback.

---

## 9. Open items (must close before any "provably fair" claim)

1. **Witness set + policy-publication root (operational, load-bearing).** The policy *design* -
   quorum `k/n`, independence requirements, reactive mode, beacon-frontier evidence,
   monitoring/dispute hooks, verifier-pinned `policy_hash`, and independent policy publication - is
   now in **§5.3**.
   What remains is **operational and unavoidable**: actually recruit `n` genuinely independent
   operators running **reactive** witnesses that meet the Fast-B SLA, stand up ≥1 independent
   **monitor**, and publish the roster through an independently witnessed policy root. Existing
   public witnesses are *not* available by default (TrustFabric's are dev/test-only). Self-operate the
   batch log if needed; **do not** self-operate the witnesses or the only policy-publication root.
   Until this is real, keep public fairness claims **off**.
2. **Upper-bound rule + `Δ`/`E` (protocol).** Candidate profiles (Fast A / Fast B / Conservative),
   the beacon-frontier "logged before `Rₑ`" argument, and the failure modes are now in **§5.2**.
   What's still open: **pick one profile**, **measure** the window budget (σ-fetch,
   witness drand-frontier fetch/subscription, reactive-cosign RTT, beacon-view skew) before fixing
   the numbers, choose `frontier_freshness_window_rounds`, and define the **miss-handling** rule
   (re-target a later `Rₑ` *with fresh witnessing* - never a silent extension). The clock-only
   argument was rejected; the beacon-frontier argument is the revised design and still needs
   measurement. If measurement cannot show the server-vs-witness drand-view skew is below the policy
   budget, Strict Fast cannot be claimed.
3. **HKDF / derivation review.** Have the key schedule (`IKM`, `salt`, `info` incl. `epoch`) reviewed
   against RFC 5869 domain separation; confirm `randomness_R`-as-IKM vs `σ_R`; keep the `info`
   encoding as canonical JCS-array bytes, not informal concatenation.
4. **Cloudflare Workers persistence.** Where the Merkle tree state + checkpoint history live
   (D1 / R2 / Durable Objects) and whether proof generation + witness round-trips fit the serverless
   latency/durability envelope. Not yet evidenced.
5. **Maturity.** The C2SP cosignature format is `v1.0.0-rc.1` (release candidate, not frozen).
6. **Reference verifier + replay/golden tests** for the full v2 chain.
7. **External audit** of *this* protocol (the tlock library audit does **not** cover TrueRolls' own
   design).
8. **`deadline_policy` format + manifest delivery.** The dispute flow + the evidence packages are now
   in §5.4 (default = **public full manifest** for non-membership). What's left: pin the
   `deadline_policy` string semantics, and decide manifest delivery at scale (inline vs a committed
   blob; a sorted-Merkle non-membership scheme only if manifest size forces it). Manifest
   availability is verifier-critical, not merely a dispute convenience.
9. **Multi-beacon liveness fallback.** Define what happens when drand quicknet stalls or becomes
   unreachable: fallback beacon candidates, quorum/ordering rules for switching, how receipts name
   the active beacon, and the bounded-wait policy. The fallback must be objective and pre-committed in
   `beacon_fallback_policy_hash`; a server-asserted post-outcome switch is invalid.
10. **Fair-mode anti-downgrade UX.** The protocol now requires a strict-v2 request + client nonce;
    product/API work still has to decide how users see a downgrade/refusal and how clients persist
    the request evidence. Without client signatures or external request logging, the nonce does not
    prove to third parties that a user demanded v2; it only makes non-v2 responses fail v2
    verification.
11. **Signer, monitor, and policy rotation.** Finalize rotation rules: non-overlapping signer
    validity windows, no overlapping witness-key validity for the same operator, monitor-policy
    updates through the same independent policy-publication root, and emergency revocation semantics.

*Resolved in this revision:* lower-bound binds the verifiable `σ_{R'}` (not a bare round number);
batch vs log inclusion proofs are separate fields; batch boundaries use a fixed epoch scheduler; a
placeholder witness-policy format exists; accepted-roll evidence is a signed pending-acceptance token
over a four-state lifecycle, with non-inclusion honestly scoped as DoS, not cheating; red-team
structural fixes added pinned verifier trust roots, beacon-frontier witness attestations, manifest
availability in the verifier path, signer-key binding, fair-mode anti-downgrade, canonical HKDF info
encoding, monitor-scoped global invariants, removal of reveal-time `index` from HKDF derivation, and
explicit independent policy-publication requirements.

---

## 10. Honest ceiling

There is **no trustless 10**. The residual, *disclosed* trust is: the drand `>½`-of-n threshold,
the `k-of-n` witness quorum, the no-post-quantum bound, and the off-chain engine's replay
correctness. "Best-in-class" here means **fully disclosed + externally audited + a real independent
witness set** - never "the house cannot possibly cheat." Score trajectory: v1 ≈ 6 → +commit-before-R
+ pinned witnessed anchor + independent policy publication + measured beacon-frontier timing
(with a real witness set) ≈ 8.5 →
+ formal threat model + reference verifier + external audit ≈ 9-9.5. The remaining points are
operational, measurement, and audit-shaped, not cryptographic.

## 11. Non-negotiable disclosure rules

Pin and monitor the drand chain hash; never publish the live threshold count as fact; demo/mock
verification is never the cryptographic check; tlock is privacy, not fairness; pin the witness policy
and signer schedule outside the receipt; state the witness trust policy plainly; and never claim
grinding/withholding/backdating/equivocation are closed without naming the assumptions in §1.

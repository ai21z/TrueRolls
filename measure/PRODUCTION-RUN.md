# TrueRolls - beacon-skew production measurement run plan

> **STATUS: PLAN - not yet executed.** This specifies how to run the §3.2/§3.3 rig in
> a real environment so the result is **auditable**, not merely produced. Read
> [docs/design/beacon-skew-measurement.md](../docs/design/beacon-skew-measurement.md)
> (the *what / why*) and [docs/design/v2-fairness-protocol.md](../docs/design/v2-fairness-protocol.md)
> (§1 safety model, §5.1 policy, §9.1 witness independence) first. This is the
> operational *how*. No public "provably fair" claim follows from this run alone - it
> measures one timing property; the witness set must be real and the protocol
> externally audited before any fairness claim (v2 §9, §11).

---

## 0. What changes from the local rig (read this first)

The committed rig (`measure/`) is a **local, single-host, single-clock** instrument. It
proves the *method*. Three things MUST change for an auditable verdict - each is a real
gap, not a flag flip. **Skip any one and the run is non-auditable even if the code runs
green.**

1. **Topology: single-host → distributed.** `witness/witness.mjs` runs the server role
   and all witness roles in **one process on one clock**, so the common offset cancels
   in `window(R)`. Real witnesses are independent operators on **their own hosts and
   clocks**. Each witness must record *its own* role on *its own* host; a cross-host
   reducer joins them. (This needs a single-role mode of the recorder, or an equivalent
   per-witness agent - see §6.)
2. **Clocks: free → NTP-disciplined + skew-bounded.** Across independent hosts,
   `window(R) = t_quorum_lost − t_server` is a difference of times on **different
   clocks**. Discipline every host, measure the residual inter-host skew bound `S`, and
   apply it **server-favorably**: `window' = t_quorum_lost − (t_server − S) = window + S`.
   Clock error can then only **inflate** the window (the safe direction), never shrink it.
3. **cosign_cost: modelled → measured.** `cosign/cosign-rig.mjs` **models** the witness
   RTT (it says so). The auditable denominator is the **real** time to submit a commit to
   the **real** witnesses and collect the k-th cosignature, under load. Drive the real
   witness cosign endpoints; the modelled rig is a sanity tool only, never the number
   that decides the gate.

The rig's safety-direction discipline (every uncertainty pushes the window **up**)
carries over; these three are what make the inputs to it real.

---

## 1. Server region / topology

- Run the server frontier probe from the **exact region / cloud / network egress** the
  production TrueRolls server (Cloudflare Worker or equivalent) would use - not a
  developer laptop.
- Use the server's **single fastest relay** (the one it would actually use). This is
  deliberately **server-favorable**: we are bounding the server's *advantage*, so any
  setup that flatters the witnesses is invalid.
- One server role only. Record its relay id and region in the run metadata.

## 2. Witness independence criteria (the load-bearing gate)

`n` witnesses, each meeting **all** of:

- **Distinct operator** - no TrueRolls ownership, control, or funding. Independence must
  be *auditable, not asserted*.
- **Distinct infrastructure** - different cloud / **ASN** / data-center; ideally distinct
  **jurisdiction**.
- **Distinct relay / network path** - no witness shares the server's relay or another
  witness's (the recorder already **fails closed on duplicate relays**).
- **Reactive cosign-capable** (C2SP `tlog-witness` shape) for Fast tiers; polling is
  acceptable only for Conservative.

Recommended quorum to start: **k=3, n=5** (tolerate 2 down; need 3 to collude); minimum
viable k=2, n=3; **k=1 is forbidden**. Publish the roster and freeze it into
`truerolls_policy_body` → `policy_hash` (v2 §5.1), distributed through an
independently-witnessed channel.

> **Honest gate.** If the witnesses share an operator, infra, or funding, "independent"
> is hollow and the run measures **nothing auditable** - fall back to Conservative +
> chain anchor. Record each witness's operator / ASN / jurisdiction / relay in the audit
> packet so a reader can check independence themselves.

## 3. NTP / clock discipline

- Every host (server probe + each witness) runs `chrony`/`ntpd` disciplined to reputable
  stratum-1/2 sources. Record per-host **offset and jitter** for the whole run.
- Derive a conservative inter-host **skew bound `S`** (e.g. the max observed `|offset|`
  across hosts, or a high percentile of it).
- **Apply `S` server-favorably** in the reducer: treat `t_server` as `S` earlier, so the
  reported window is `window + S`. Clock error then only overstates the window.
- If `S` cannot be bounded (clocks undisciplined), the cross-host window is **unmeasurable**
  → the run is invalid. (Single-host runs from §0 don't need this, but they aren't
  independence-auditable.)

## 4. Relay selection rules

- **Server:** the single fastest relay it will use in production.
- **Witnesses:** each a **distinct, independent** relay / path - **not all
  drand-operated**; prefer AS- and geographically-diverse mirrors that resemble a real
  witness's connectivity, *including deliberately worse paths* (the threat is a witness
  that lags the server).
- Pin enforced in code: chain hash + **group public key** (`assertPinnedKey`), scheme
  `bls-unchained-g1-rfc9380`, and schedule, checked on **every** relay's `/info`; any
  relay failing the pin is rejected, fail-closed.
- Drop (never silently keep) rounds whose σ fails BLS verification; they are recorded
  `blsOk:false` and the reducer treats them as "never advanced" (window-up).

## 5. Run duration & sample size

- **Days, not minutes** - span diurnal network variance, drand round jitter, and a
  **peak-load** window. The **tail (p99.9)** is the product, not steady state.
- Sample-size floor from the decisive metric. For **zero** observed exploitable rounds,
  the Clopper-Pearson upper 99.9% bound is `1 − 0.001^(1/n)`; to clear the target
  `exploitable_fraction` threshold `< 1e-4` you need (verified with the rig's own
  arithmetic):

  | rounds `n` | CP-upper(0,n) | days @ 3 s/round |
  |---|---|---|
  | 69,075 | 1.00e-4 | 2.40 |
  | 86,400 | 8.0e-5 | 3.00 |
  | 259,200 | 2.7e-5 | 9.00 |

  → **≥ ~70k clean rounds (~2.5 days) is the floor; budget ≥ 3 days** for diurnal
  coverage and margin. **Any** observed exploitable round means you have not cleared the
  threshold (and likely fail gate (2) outright) - investigate, do not just extend.

## 6. Exact commands / env vars

Run `node lib/drand-bls.mjs --selftest` first on **every** host; it must print
`SELFTEST PASS` including **`WRONG KEY rejects real σ ✓`** before any data is trusted.

| Component | Invocation | Key env / args |
|---|---|---|
| BLS gate | `node lib/drand-bls.mjs --selftest` | - |
| Frontier (§3.2) | `node witness/witness.mjs` | `SERVER_RELAY`, `WITNESS_RELAYS` (csv), `WITNESS_DELAYS_MS` (csv, modelling only - **omit in production**), `ROUNDS`, `POLL_MS=80`, `DEADLINE_PERIODS=4`, `OUT` |
| Cosign (§3.3) | drive the **real** witness cosign path (see §0.3); `cosign/cosign-rig.mjs -k K -n N` is a **placeholder/sanity** tool whose RTT is modelled | `ATTEMPTS`, `LOAD`, `COSIGN_RTT_*` (modelled only) |
| Reduce (§4/§5) | `node reduce/window.mjs --frontier <f> --cosign <c> -k K` | `CP_ALPHA=0.001`, `EXPLOIT_THRESHOLD=1e-4` |

- **Distributed mode (production):** each witness host runs the recorder for **its own
  role only** (a single-role mode of `witness.mjs`, to be added), writing its own
  frontier JSONL; the central reducer joins all witness files + the server file, applying
  the §3 skew bound. The committed single-host invocation above is the local
  approximation, not the production topology.
- **`WITNESS_DELAYS_MS` is a stress/modelling knob - never set it in a production run**
  (it would fabricate skew).

## 7. Artifact naming & storage

- Naming: `frontier-<role|witnessId>-<region>-<startISO>.jsonl`,
  `cosign-<region>-<startISO>.jsonl`, plus a `run-metadata-<startISO>.json`
  (topology, relays, NTP offsets, `S`, params).
- Raw datasets are **git-ignored** (`measure/**/*.jsonl`) and can be large - store them in
  durable external storage (object store), keyed to the run id. Keep the full raw set
  retrievable for audit; retain at least a sampled subset alongside the report.

## 8. What must NOT be committed

- Raw `*.jsonl` datasets (git-ignored - store externally; commit only the **hash** + a
  retained sample reference).
- `node_modules/` (git-ignored).
- Any witness operator secrets, private keys, or signer material.
- Only the **signed measurement report** and the **methodology hash** are repo/policy
  artifacts.

## 9. Reducer / pass-fail procedure

1. Join all frontier files (server + witnesses) + the cosign-cost samples; apply the §3
   clock-skew bound `S` to `t_server`.
2. `node reduce/window.mjs …` → `window(R)` (combined censored-tail rule), `cosign_cost`,
   `exploitable_fraction` + Clopper-Pearson upper bound, gate verdict.
3. **Censored-dominated rounds** (window=∞: ≥k witnesses never BLS-verified-advanced) must
   be **investigated** - real last-look opportunity vs witness slowness. A nonzero,
   unexplained count blocks a clean Strict-Fast claim (they correctly count exploitable
   and dominate the tail).
4. Per §5, **Strict Fast** requires **all three**: (1) `exploitable_fraction` CP-upper
   `< 1e-4`; (2) `p99.9 window < p1 cosign_cost`; (3) **margin** - `Δ`/`s` set with slack,
   not at the measured edge.

## 10. Audit-packet evidence (measure-spec §6)

The signed report must contain:

- **methodology hash** - of this file + the measurement spec.
- **raw dataset hash** (+ retained sample reference).
- **topology** - server region/relay; per-witness operator / ASN / jurisdiction / relay
  / mode.
- **clock discipline** - NTP sources, per-host offset/jitter, the skew bound `S` applied.
- **computed distributions + CIs**, and the **verdict** (tier + chosen `E` / `Δ` / `s`).
- **explicit measured-vs-modelled disclosure** - especially that `cosign_cost` was
  measured against real witnesses (or, if not, that the verdict is provisional), and
  whether witnesses were real-independent or dev.
- `measurement_report_hash = SHA-256(JCS(report))`, pinned into
  `truerolls_policy_body.witness_policy.beacon_frontier.measurement_report_hash` (v2 §5.1)
  so the deployed timing params are justified by a specific, immutable measurement.

## 11. Verdict mapping - Strict Fast vs Conservative

**Strict Fast (Fast B default)** only if §9 conditions (1)+(2)+(3) all pass **with
margin**, witnesses are genuinely independent, and `cosign_cost` was **measured** (not
modelled).

**Conservative is forced** if **any** of:

- `exploitable_fraction` CP-upper `≥ 1e-4`, or any exploitable round is observed;
- `p99.9 window ≥ p1 cosign_cost`;
- witnesses cannot be sourced with genuine operator/ASN/path independence;
- censored-dominated rounds remain unexplained;
- inter-host clock skew `S` cannot be bounded;
- `cosign_cost` is only modelled, not measured against real witnesses.

Conservative makes **no** seconds-latency claim. **No public "provably fair" claim** until
the witnesses are real and independent **and** the external protocol audit is complete
(v2 §9.1, §9.7, §11).

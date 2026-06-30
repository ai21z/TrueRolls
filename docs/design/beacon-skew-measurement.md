# TrueRolls v2, Beacon-skew measurement protocol

> **STATUS: DRAFT / PROPOSED, MEASUREMENT SPEC, not yet executed.** This document specifies *what
> to measure and how to decide* **before** any harness is built, so the harness can't drift into
> measuring the wrong thing. It feeds three downstream artifacts: the harness implementation, the
> `Δ` / `frontier_freshness_window_rounds` / tier decision in the witness policy
> ([v2 spec §5.1-§5.2](v2-fairness-protocol.md)), and the audit packet (its report hash is pinned as
> `truerolls_policy_body.witness_policy.beacon_frontier.measurement_report_hash`).

---

## 0. The one question

Strict Fast's entire fairness claim rests on **v2-spec §1 assumption (5)**: a server cannot see
`σ_{Rₑ}` *materially before* an honest witness quorum would refuse to keep cosigning for epoch `e`.
This protocol measures whether that holds in reality, and with how much margin.

**Measure the *window*, not the average.** The tempting metric, "server mean drand latency vs
witness mean drand latency", is the wrong thing. A single exploitable round is a grind opportunity,
so safety is a **tail** property of a **per-round window**, compared against the **time it takes to
execute a last-look**.

---

## 1. The safety model (what makes a round exploitable)

For a candidate reveal round `R = Rₑ`, define three observation-time quantities:

- **`t_server(R)`**, wall-clock time the server obtains *and verifies* `σ_R` via its **best**
  relay. (The server is the entropy fetcher, assume it optimizes this. This is the attacker's "I now
  hold the seed and the outcome" moment.)
- **`t_w(R)`** for each witness `w`, wall-clock time `w`'s independently observed drand frontier
  advances to round `R` (i.e. `w` would now attest `observed_drand.round = R`, no longer `< R`).
- **`t_quorum_lost(R)`**, the **(n − k + 1)-th** order statistic of `{ t_w(R) }`. After this
  instant, fewer than `k` witnesses still observe frontier `< R`, so the server can **no longer**
  assemble `k` cosignatures with `observed_drand.round < R` from honest witnesses.

The **last-look window** on round `R`:

```
window(R) = max(0, t_quorum_lost(R) − t_server(R))
```

During `window(R)` the server holds `σ_R` (outcome known) **and** a quorum still observes `< R`
(pre-Rₑ cosigs still obtainable). A last-look is **feasible** iff the window is long enough to run
the attack:

```
exploitable(R)  ⟺  window(R) ≥ cosign_cost
```

where **`cosign_cost`** is the measured time for the server to submit a commit and collect `k`
reactive cosignatures (the attack's execution latency, §3.3). `s = frontier_freshness_window_rounds`
sets the *lower* bound on acceptable `observed_round` (tolerating witnesses that lag by ≤ `s`). The
**upper bound `< R`** is what closes the window, so `s` does not widen it.

> Note: everything is **observation-time** based (actual `σ_R` arrival), not drand's *scheduled*
> round time, so late/jittery rounds are handled correctly by construction.

---

## 2. What is recorded (raw dataset)

For every drand round `R` in the sample, one record:

| Field | Source | Meaning |
|---|---|---|
| `R`, `chain_hash` | drand | the round |
| `t_round_sched` | `genesis + R·period` | scheduled time (jitter reference only) |
| `t_server(R)` | server probe | σ-fetch+verify time, best relay |
| `server_relay_id` | config | which relay the server used |
| `t_w(R)` per `w` | each dev witness | frontier-advance time for `w` |
| `witness_relay_id` per `w` | config | each witness's relay (must differ from the server's and from each other) |
| `verified` per party | BLS check (self-consistency only in the §3.1 standalone probe; full BLS in §3.2) | σ_R verified under the pinned chain; drop unverified samples |

Derived per round: `t_quorum_lost(R)`, `window(R)`, `exploitable(R)`, and `server_advantage(R) =
t_quorum_lost(R) − t_server(R)` (signed, negative = witnesses lead = safe).

Separately, a **`cosign_cost` sample set** from §3.3 (independent of `R`).

---

## 3. Method

### 3.1 Server drand view (standalone, measurable now, no witnesses)
A Worker subscribes to drand quicknet via its chosen relay(s) and timestamps the arrival of each
`σ_R`. Run from the **production region/topology** the real server would use, with its fastest relay,
to capture the **worst case for fairness** (max server advantage).

> **Verification scope (current probe).** The standalone probe checks drand **self-consistency only**
> (`randomness == SHA-256(σ)`), it does **not** BLS-verify `σ` under the quicknet group key. Full BLS
> verification under the pinned chain + dropping unverified samples is a **§3.2 requirement** (the
> witnesses must BLS-verify their own frontier) and must be added before any audit-grade number is
> pinned via `measurement_report_hash`. Until then §3.1 yields timing samples, not authenticated σ.
>
> **What §3.1 does and does not bound.** The relay spread bounds skew **across the configured relays
> only**, an indicative **lower** bound on the server's advantage, **not** an upper bound over real
> witnesses. A real independent witness (§3.2) may sit on a worse path than any configured relay, so
> the true server-vs-witness skew can exceed this spread. §3.1 alone cannot conclude the window is
> ≤ 0, it is necessary-not-sufficient evidence feeding the §3.2/§3.3 decision.

### 3.2 Witness drand view (needs dev witnesses)
Stand up **`n` local/dev witnesses**, each:
- a minimal `c2sp.org/tlog-witness`-shaped service that, on each round, records `t_w(R)` (its own
  observed+verified frontier) and can cosign a checkpoint with `observed_drand.{round,sigma,chain_hash}`,
- on a **distinct network path / relay / region** from the server and from each other (the variable
  we're characterising is *relay-path diversity*, so homogeneous witnesses would measure nothing).

> **Dev witnesses measure TIMING ONLY.** They are **not** a fairness substitute, independence of
> the *real* witness operators is a separate operational gate (v2-spec §9.1) and no public fairness
> claim follows from this measurement. The dataset must record that these were dev witnesses.

### 3.3 Cosign cost (the attack-execution latency)
Measure, per attempt, the time for: build+sign commit → submit to the witness set → collect the
`k`-th reactive cosignature. This is `cosign_cost`. Run it under the same topology and under **load**
(it is the denominator of exploitability, under-measuring it overstates safety).

### 3.4 Conditions (orient the measurement adversarially)
- **Real drand quicknet** (League of Entropy), never a mock.
- **Long duration**, days, spanning network diurnal variance, drand round jitter, and a peak-load
  window. Tail behaviour, not steady state, is the product.
- **Server-favourable**, server fastest relay, witnesses realistic independent relays. We are
  bounding the server's *advantage*, so any setup that flatters the witnesses is invalid.
- Drop rounds with unverified `σ_R` or missing witness samples, report the drop rate.

---

## 4. Metrics

Report **p50 / p95 / p99 / p99.9 / max** for each:

- `server_advantage(R)` (the headline distribution, signed)
- `window(R)`
- `t_server(R)` σ-fetch latency (vs scheduled)
- `t_w(R)` per-witness and quorum (`t_quorum_lost`) frontier latency
- `cosign_cost`

And the scalar that decides it:

- **`exploitable_fraction` = P[ window(R) ≥ cosign_cost ]** over the sample (with a Clopper-Pearson
  upper confidence bound, since the safe answer is "≈ 0" and we need an honest bound on the tail).

> **Censored tail.** Any quantity with censored samples (e.g. relay spread when a relay misses the
> §3.1 deadline) must report its tail as the **combined** order statistic over exact values **and**
> censored lower bounds, `max(exact pXX, censored-lower-bound pXX)`, treating each censored sample as
> ≥ its lower bound. Never quote the exact-only percentile as the tail, that silently drops the worst
> rounds.

---

## 5. Pass / fail, Strict Fast vs Conservative

**Strict Fast is viable** only if, over a large adversarial sample, **all** hold:
1. `exploitable_fraction` upper 99.9% CI bound is **below a stated negligible threshold** (target: 0
   observed exploitable rounds, with the CI bound quoted, e.g. `< 1e-4`),
2. `p99.9 window(R) < p1 cosign_cost`, the worst window cannot fit even the *fastest* attack,
3. there is **margin**: `Δ` and `s` are then set so the honest path clears with slack (e.g.
   `Δ ≥ cosign_cost p99 + σ-fetch p99 + a stated buffer`), not at the edge of the measured window.

If any fails → **Strict Fast is not claimed.** Fall back to **Strict Conservative** (minutes-scale
`Δ`, polling witnesses and/or periodic chain anchor), where the window is dominated by `Δ` and the
relay-advantage tail is irrelevant. Conservative makes **no** seconds-latency claim.

Edge cases that force Conservative regardless: server relay advantage is structurally unavoidable and
positive at p99, witnesses cannot be sourced with genuine path diversity, drand jitter routinely
exceeds the safety buffer.

---

## 6. Audit-packet output

The run produces a signed **measurement report** containing: the raw per-round dataset (or its hash +
retained sample), the server/witness relay+region topology, the methodology hash (this document), the
computed distributions and CIs, the verdict (tier + chosen `E`/`Δ`/`s`), and the explicit
disclosure that dev witnesses measured timing only.

`measurement_report_hash = SHA-256(JCS(report))` is pinned into
`truerolls_policy_body.witness_policy.beacon_frontier.measurement_report_hash`, so a verifier/auditor
can confirm the deployed timing parameters are justified by a specific, immutable measurement, not
asserted. Re-measure and re-pin on any material relay/topology change.

---

## 7. What this does NOT establish

- **Witness independence**, operational, separate gate (§9.1). Dev-witness timing ≠ trust.
- **Cryptographic correctness** of the protocol, that is the external audit (§9.7).
- **Liveness under drand stall**, the multi-beacon fallback (§9.9).

This protocol settles exactly one thing: whether the **measured** server-vs-witness beacon-view skew
lets Strict Fast hold, and with what margin, or whether the honest answer is Conservative-only.

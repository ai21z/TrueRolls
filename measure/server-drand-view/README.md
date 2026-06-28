# §3.1 - Standalone server-drand-view probe

Throwaway measurement harness for the **server half** of the beacon-skew gate
([../../docs/design/beacon-skew-measurement.md](../../docs/design/beacon-skew-measurement.md) §3.1).
**No witnesses needed** - it yields the server-half input (indicative, not decisive): *how fast does
the server see `σ_R`, and how much faster is its best relay than the other configured relays?*

## Run

```
node probe.mjs            # Node 20+, zero dependencies
```

Env knobs: `ROUNDS=20` · `POLL_MS=80` · `DEADLINE_PERIODS=4` ·
`OUT=server-drand-view.jsonl` · `RELAYS=url1,url2,…`
A real run wants `ROUNDS` in the thousands (days), from the **production region** the server would
use, with NTP-disciplined clocks.

## What it records

Per quicknet round `R`, in `OUT` (JSONL): each relay's `σ_R` first-arrival latency vs the scheduled
round time, the per-round **relay spread** (slowest − fastest), censored lower bounds when one or
more relays miss the deadline, and a `randomness == SHA-256(sig)` consistency flag (`badSig`).

## How to read it

- **Relay spread** is the headline and is **clock-robust** (one machine clock, common offset cancels).
  It is the spread **across the configured relays only** - an **indicative lower bound** on the
  server's advantage, **not** an upper bound. A real independent witness (§3.2) may sit on a worse
  path / ASN / region than any relay here, so the true server-vs-witness skew can **exceed** this
  spread. Real skew is pinned only by §3.2; a small, tight spread here is *necessary-not-sufficient*
  early evidence for Strict Fast, never the decision.
- **Censored rounds** are not exact spreads. If a relay misses the deadline, the output records
  `relaySpreadLowerBoundMs`; the actual tail is at least that large and may be worse. Do not mix
  censored lower bounds into exact percentile claims without labeling them.
- **Combined-tail decision rule.** The gate statistic is the tail over **both** buckets together -
  `max(exact pXX, censored-lower-bound pXX)`, treating each censored round as ≥ its lower bound.
  Never read the "EXACT RELAY SPREAD" block alone, or the worst rounds (a relay so slow it was
  censored) silently drop out and understate the tail.
- **σ is self-consistency-checked, not BLS-verified** (`badSig` = `randomness != SHA-256(σ)`). Full
  BLS verification under the quicknet group key + dropping unverified samples is a §3.2 step; until
  then these are timing samples, not authenticated beacon values.
- **Per-relay absolute latency** carries the local clock offset; treat it as relative, not absolute,
  unless the host is NTP-synced.

## Scope (read this)

Timing only - **not** a fairness measurement and **not** a witness-independence claim. The witness
half (per-witness frontier, §3.2) and the attack-execution cost (`cosign_cost`, §3.3) come next and
need the dev-witness rig. A local run here validates the method and yields a first read; the
production-topology, long-duration run produces the number that pins into the policy
(`measurement_report_hash`).

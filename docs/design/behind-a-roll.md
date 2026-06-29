# Behind a TrueRoll - design note

> **Provenance.** Design note, 2026-06-29. Locks the concept and the honesty
> contract for an interactive educational page BEFORE any component code is
> written. This is trust-sensitive UI: the danger is not layout, it is
> accidentally implying stronger fairness than TrueRolls currently proves. No
> implementation is described here as shipped unless explicitly marked so.
>
> Build target: `services/loom-demo` in THIS repo (truerolls). The page is a new
> route; the existing `/verify` page is left focused and untouched.

Companion notes:

- [`../../crates/kd-receipt/src/lib.rs`](../../crates/kd-receipt/src/lib.rs) - the single shared verifier the page reuses.
- [`auth-and-key-lifecycle.md`](auth-and-key-lifecycle.md)
- drand backing + replay scope: the receipt versions `truerolls-1` (legacy, no drand) and `truerolls-drand-1` (beacon-backed).

---

## Part 0 - the honesty contract (governs everything below)

This page exists to make the trust chain visible. It must never make a roll look
more fair than it is. These rules are non-negotiable and precede layout:

```text
B = real verifier engine        (the browser actually recomputes; never a mock)
A = ceremony ONLY around real evidence
C = compact index
No fake server testimony         (no invented "server is doing X" live stream)
No "operator cannot cheat" implication
Legacy receipts degrade honestly (truerolls-1 shows no drand provenance)
kappa = 0 baseline is educational, not proof of fairness
```

The standing limit, shown persistently on the page (not only at the end):

```text
Proves: seed provenance and replay.
Does NOT prove: the operator could not refuse, time out, or suppress an
unfavourable attempt before this receipt existed (the v2 witnessed-commitment
problem).
```

Every per-station detail panel also carries its own `Limit` line.

---

## Part 1 - the metaphor and the aesthetic

The page reads a roll as a forensic chain of custody. This is not imposed on the
site; it extends the existing NECROGRAPHY vocabulary already used by
`RollSigil`: "a roll is a death; the receipt is its residue; read the residue as
a forensic lineage."

Extension: the roll is a specimen, its custody chain is a single hypha strand,
each station is an evidence plate where a seal is pressed, and a loupe magnifies
the station under examination.

House rules taken from the live tokens (`src/theme/tokens.css`) and `RollSigil`:

- State is NEVER a check/cross glyph. It is read from the material:
  a whole pressed wax seal (witnessed), a dry unsealed stamp (not yet
  witnessed), or a cracked seal weeping ember + a severed strand (tampered).
- Forensic state words, not "valid/invalid": e.g. Unsealed / Sealed / Severed.
- The warm focal (ember `--kd-focal`) marks the *cut in the fairness claim*: a
  failure (`severed`) and the persistent honesty-limit callouts (standing banner,
  per-stratum `Limit` tags). It is NOT neutral chrome - A's cycling phase label,
  which passes through success phases too, uses a muted tone, never the focal.
- Grain on every plate; hand-drawn ink borders (`InkFrame`/`inkRect`); the
  carved assay cell whose fill is its state; tiny mono "measure" captions.
- Verified = fungal green `--kd-ember`; tamper = blood red `--kd-fail`;
  structural accent = ashen green `--kd-accent`.

Framing discipline: the die is witnessed and re-checked, not transformed by a
"magic machine." Avoid forge/chamber/seal-press language that drifts toward
"magic randomness."

---

## Part 2 - three surfaces, one vocabulary

| Surface | Role | What it is | Status |
|---------|------|-----------|--------|
| B - Specimen Plate | the engine | The real WASM verifier, instrumented to emit one step per check; the receipt's strata read under a loupe. | build first |
| A - Custody Strand | the ceremony | A nine-station rail; an artifact travels it (die -> unsealed draft -> sealed receipt). Live client steps + the real beacon wait, ending in B's recompute. | build second |
| C - Contact Sheet | the index | The completed chain compressed into a small wrapped grid of sealed cells; click any to reopen its record. Shared end-state/navigation for A and B. | build third |

Route decision: a new dedicated route `/behind-a-roll`. The existing `/verify`
stays a focused receipt verifier. Rationale: `/verify` does one job (verify a
pasted/uploaded receipt); mixing in the full teaching flow would overload a
working trust page.

---

## Part 3 - the nine stations and the artifact

Zones: 01-03 CLIENT, 04-08 SERVER, 09 YOUR BROWSER.

```text
01 Nonce cast        client   proof.client_nonce
02 Beacon observed   client   proof.drand.client_observed_round
03 Target locked     client   target_round == observed + 2
04 Custody opened    server   POST /v1/roll (validate + lock)
05 Beacon revealed   server   randomness = SHA256(BLS-verified target sig)
06 Seed forged       server   HKDF -> proof.rng.drbg_key_hex
07 Outcome sampled   server   kd-core prefix-CDF (no modulo); face, alpha, KL, EV
08 Seal pressed      server   Ed25519 sig over JCS body
09 Re-examined       browser  the WASM verifier replays and matches every field
```

The travelling artifact (A) and its honest staging:

```text
die           rolls 01 -> 03, then PARKS at 03 (the cast is fixed client-side)
unsealed draft a faint, dashed document crosses 04 -> 08 (the record being built;
              it is NOT a signed receipt yet)
sealed receipt the Ed25519 stamp at 08 turns the draft into a solid receipt,
              which crosses into the browser at 09
```

Rule: nothing is drawn as a signed receipt before station 08. A station only
seals (fungal green) behind the artifact; ahead is dotted/unwitnessed.

Animation honesty (station 07): show the seed fixed FIRST, then the draw landing
in whichever prefix-CDF bucket. kappa only reshapes bucket widths, within the
KL/EV caps drawn as visible walls, BEFORE the draw exists. Never show kappa
nudging the die toward a "good" face.

---

## Part 4 - what is real, and what is "confirmed by recompute"

Established by step 0 (commit `ebb0008`): the compiled `kd-core-wasm` bundle's
drand BLS pulse verify RUNS in wasm32. It accepts a real `truerolls-drand-1`
golden (VALID, `valid_drand=true`) and rejects a forged target signature
(INVALID, "drand BLS signature verification failed"). Goldens
`golden_receipt_03_d20_drand.json` (clean) and
`golden_receipt_04_d20_drand_tampered_sig.json` (tampered) are committed and
pinned by host tests in `kd-core-wasm`.

| Stations | Realness on the page | Why |
|----------|----------------------|-----|
| 01-03 client | real, live | browser mints nonce, fetches + BLS-verifies the frontier, locks observed+2 |
| 05 beacon reveal | real, live | the browser independently fetches + BLS-verifies the target pulse when it publishes (proven runnable in wasm by step 0) |
| 04, 06, 07, 08 server-internal | real by RECOMPUTE, not live | not watchable as they happen; station 09 re-derives seed/draw/face/sig in the browser and matches. This is stronger than server self-narration. |
| 09 re-examine | real, now | `verifyReceiptJson` -> `kd_receipt::verify_receipt_str` runs the full check (Ed25519, drand BLS, HKDF, ChaCha20 replay, kd-core recompute) |

Hard rule from Part 0: NO fake server testimony. The page must not stream
invented "server is now deriving the seed" progress. Server-internal stations
are presented as pending until the receipt returns, then confirmed by the
browser's own recompute. No backend SSE/trace endpoint is built or implied.

---

## Part 5 - the kappa = 0 baseline (educational, not proof of fairness)

The page can run at `kappa = 0` (the neutral die, uniform by construction) and at
a non-zero stance. Purpose: let any observer see that the neutral die is flat,
then see a stance bend stay inside the KL/EV caps. The receipt carries the signed
`kappa`, and the verifier recomputes the exact distribution for whatever kappa it
is, so no reading is hidden.

This is a transparency aid, NOT a fairness proof. `kappa = 0` being flat does not
prove anything about whether the operator could suppress an attempt; it only
shows that, given a roll that completed, the neutral stance does not weight the
die. State this on the page; do not let the baseline imply more.

---

## Part 6 - legacy receipts degrade honestly

The page reads `receipt.v`:

- `truerolls-drand-1`: the full beacon-backed chain above.
- `truerolls-1` (legacy, no drand): show ONLY the honest reduced chain -
  signature + sampling/face/metrics replay. The drand stations (02, 05, and the
  beacon-provenance parts of 09) are explicitly marked "not present for this
  receipt - no drand provenance." Never render a legacy receipt as if it had a
  verified beacon seed.

**All three surfaces obey this from one predicate** (`hasBeacon` in
`receiptFields.ts`): B and C mark the drand stratum absent, and A (the ceremony)
marks the beacon stations (01/02/03/05) absent - they never seal, and their copy
never asserts a verification that did not happen.

This turns the legacy gap into a teaching moment instead of hiding it.

---

## Part 7 - implementation boundary (first cut)

In scope for the first build (after this note):

1. New route `/behind-a-roll` (hash-routed, consistent with the existing app).
2. B - the Specimen Plate: instrument the existing WASM verify path
   (`src/api/wasmEngine.ts` -> `verifyReceiptJson`) to surface one step per
   check, fed by a real `truerolls-drand-1` receipt (a bundled sample, then the
   user's own). Reuse, do not fork, the verifier.
3. The persistent standing-limit banner and per-station `Limit` lines.
4. Honest `receipt.v` branching (Part 6).

Out of scope for the first cut (later steps, same note governs them):

- A - the custody-strand ceremony + artifact animation (build second).
- C - the contact-sheet index (build third).
- The `kappa = 0 / kappa` toggle (can ship with A; Part 5 governs it).
- Any backend change. There is none: the page is pure frontend over the existing
  WASM verifier and public drand relays.

Reduced motion: all animation (A) gated by `prefers-reduced-motion`; the static
end-state must be fully legible without motion.

---

## Status summary

| Item | Status |
|------|--------|
| BLS-in-wasm proven (step 0) | done, commit `ebb0008` |
| truerolls-drand-1 goldens + host tests | done |
| This design note / honesty contract | committed `bf15817` |
| `/behind-a-roll` route + B (Specimen Plate) | done, commit `ddbbf23` |
| A (custody strand + artifact animation), version-aware | done, commit `af53ad3` + holistic-review fixes |
| C (contact sheet / custody index) | done, commit `8696b48` |
| Holistic adversarial review + fixes (F1-F21 batch) | applied |
| kappa = 0 / kappa toggle | not started |

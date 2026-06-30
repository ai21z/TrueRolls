# v2 Fairness Protocol, Adversarial Audit (Batch-Commitment Threat Model)

> **Provenance.** Adversarial audit, 2026-06-28, of [`v2-fairness-protocol.md`](v2-fairness-protocol.md) and the planned **Layer-2** batch-commitment design (many rolls committed under one pre-published Merkle root resolved by a single future drand round, with per-roll domain-separated HKDF seeds). The design doc is strong and already anticipates the major attack classes. This companion **confirms the sound parts against primary sources (RFC 6962, C2SP)** and **sharpens four under-stated gaps**. Related: [`beacon-skew-measurement.md`](beacon-skew-measurement.md).
>
> **Editor's correction (folded in by the human reviewer):** the audit agent originally called `crates/kd-api/src/services/rng.rs` (`kd-roll-v1`) "the only shipping seed-derivation code." That is stale. The **shipping v1 per-roll seed derivation is `kd_drand::derive_roll_seed`**, HKDF-SHA256, `salt = idem_payload_sha256`, `IKM = the target round randomness`, `info = JCS array` binding version/chain/**round**/die/kappa/nonce/idem-hash (`roll.rs:301`). It already binds the round. The older `rng.rs` module is **dead legacy**, not wired into `post_roll`. Where the catalogue below contrasts v2 against a "v1 with no round binding," that refers to the dead `rng.rs`, not the live drand path.

**Status: design only, NOT YET BUILT.** No batch/Merkle code exists yet. Every `kd-receipt` v2 finding below is about code to be written. The existing design already covers grinding (A), withholding (B), backdating (C), equivocation (D), front-running (E), boundary-gaming (F), non-inclusion (G), downgrade (H) and correctly refuses a "trustless" claim.

## Assets & trust assumptions

**Assets:** (1) the per-roll outcome's unpredictability before the target round resolves. (2) The integrity of the published `batch_root` and its manifest. (3) The binding between each receipt and the round that produced it. (4) The non-equivocation guarantee (one view of history). (5) The signing key(s) and witness quorum keys.

**Trust assumptions:**
- drand quicknet is honest and live (its group key is pinned, σ is unforgeable). This gives the **lower** time bound for free.
- A k-of-n witness quorum is honestly independent and its members' drand views are not all skewed past the target round before signing.
- At least one monitor performs a complete log scan via paths independent of the operator.
- **There is NO purely-cryptographic upper time bound** (anti-backdating). This is the central, irreducible trust claim and the design says so.

## Actors

- **Honest player**, submits a roll, later holds a receipt, wants to verify their outcome was bound before the round.
- **Malicious/rational operator**, controls roll acceptance, batch assembly, the log endpoint, and manifest hosting, wants favorable outcomes (grinding) or selective exclusion while keeping receipts that pass per-receipt checks.
- **Witnesses (k-of-n)**, cosign checkpoints, honest-but-independent assumption, a colluding subset is the main quorum threat.
- **Monitor(s)**, scan the log for equivocation and double-commits, only effective if sourcing checkpoints independently.
- **Network/relay adversary**, can skew which drand frontier a party observes first (beacon-view skew), enabling last-look attacks.

## Attack catalogue

### 1. Selective withholding (drop a roll, or withhold the manifest), HIGH
**Mechanism (design §3.2, §5.4, §6 check 4).** The operator publishes a witnessed `batch_root` but the manifest enumerating leaves is a separate blob. Three variants:
- **(a) Drop a specific accepted roll.** Closed *only* if the player holds a signed `pending_acceptance` token, without one, a dropped roll is indistinguishable from "never received" = DoS (the design states this honestly).
- **(b) Publish the root but never serve the manifest.** Verifier check 4 voids the batch, correct, but a void is a *liveness event the operator can trigger selectively*. The operator knows batch contents at build time and learns σ at reveal, so it can void exactly the batches whose composition is unfavorable. With a tight Δ the voided batch re-targets to a later round. **Void-then-recommit is multi-candidate grinding across void cycles** unless a monitor forbids it.
- **(c) Equivocate the manifest** (serve different manifests to different verifiers). Closed only if `manifest_hash` is inside the witnessed commit (it is, §3.3) **and** verifiers actually check `H(JCS(manifest)) == manifest_hash` (check 4).

**Mitigation + verifier checks:**
- The monitor invariant must be explicit: **a voided/re-targeted epoch must re-commit the same-or-superset accepted-token set under a fresh witnessed root**. Dropping accepted-token leaves on retry is provable cheating (inclusion-package across the retry).
- Voids must carry a **witnessed, signed reason code**. Today a void is just "fewer than k cosigs" or "manifest missing," either of which an operator can manufacture as cover for selective withholding. A signed reason removes that cover.
- Treat manifest availability as a first-class **data-availability** problem: anchoring the root proves *what* was committed, never that the preimage is *retrievable*. This is the same residual CT has and is the strongest remaining gap.
- Verifier must check: `manifest_hash` is inside the witnessed commit, `H(JCS(manifest)) == manifest_hash`, the player's leaf is present in the manifest and its inclusion proof to `batch_root` verifies.

### 2. Equivocation / split-view, confirmed mitigated (needs quorum + independent monitors)
**Mechanism (RFC 6962 §"two conflicting STHs", C2SP tlog-witness).** A Merkle log signature alone proves nothing about equivocation, a log can present two conflicting consistent views. The design's claim that k-of-n independent witnesses close split-view and that equivocation is "invisible in real time but publicly provable after the fact" matches RFC 6962 exactly: detection is an out-of-band social/operational process (gossip + auditors), not a real-time cryptographic guarantee. **This is a confirmation, not a defect.**

**Caveat to surface:** RFC 6962 requires gossip/auditor exchange of checkpoints for equivocation to actually be *detected*. A single monitor that reads only the operator's own log endpoint can itself be shown a consistent fake view. The detection guarantee requires monitors/clients to compare checkpoints obtained via **independent paths**, the witnesses' own published cosignatures and client-held receipts, not solely the operator's endpoint. §5.3 should state this.

*Citation: RFC 6962, https://www.rfc-editor.org/rfc/rfc6962 . C2SP tlog-witness, https://github.com/C2SP/C2SP/blob/main/tlog-witness.md*

### 3. Nonce / domain-separation collisions, MEDIUM
**Mechanism (design §3.3/§3.4).** The v2 seed derivation is `HKDF(salt = batch_root, IKM = randomness_R, info = JCS(["truerolls-v2-strict", chain_hash, epoch, Rₑ, roll_id, leaf_i]))`. This is the correct direction. *(Editor's note: this is an improvement over the **dead** `rng.rs` `kd-roll-v1`, whose IKM has no round binding. The **live** v1 `kd_drand::derive_roll_seed` already binds the round, so v2's gain over the live path is the per-leaf/epoch binding, not round binding per se.)* Pitfalls:
- **(a) Per-item uniqueness is asserted, not enforced.** Two distinct accepted payloads colliding on operator-assigned `roll_id` still yield distinct leaves (full payload hashed) so seeds differ, OK. But uniqueness of `(roll_id, client_nonce)` is only a *verifier-side manifest check* (check 4), not enforced at acceptance, so a duplicate can enter the signed `pending_acceptance` token in the first place.
- **(b) Binding cycle:** `leaf_i = SHA256(JCS(precommit_payload))` and `precommit_payload` does **not** contain the seed/outcome, so no circularity. Confirmed sound.
- **(c) Cross-epoch replay** is correctly defeated: `info` includes `epoch` and `Rₑ`, so the same `(roll_id, client_nonce)` in a different epoch yields a different seed, good. Keep `info` as canonical **JCS-array bytes**, not raw `0x00`-delimited concatenation (a canonicalization-ambiguity smell, do not carry it into v2).

**Mitigation + verifier checks:** enforce `(roll_id, client_nonce)` uniqueness as an **operator invariant at acceptance** (reject duplicates within an epoch) so a duplicate never enters a `pending_acceptance` token. Verifier checks the manifest has no duplicate `(roll_id, client_nonce)` and recomputes `leaf_i` from the precommit payload. Goldens: two rolls differing only in `roll_id` must get distinct seeds, the same `(roll_id, client_nonce)` across epochs must diverge.

*Citation: RFC 5869 (HKDF), IKM/`info` separation.*

### 4. Commit-after-emission timing (backdating / beacon-view skew), HIGH
**Mechanism (design §4, §5.2, assumption 5).** drand gives the **lower** bound cryptographically and for free: a root that incorporates σ_{R'ₑ} was built ≥ R'ₑ, and a backdater cannot forge σ. The **upper** bound ("logged before Rₑ") cannot be cryptographic, it equals "a k-of-n quorum signed while its own drand frontier was < Rₑ." The surviving attack is **beacon-view skew**: if the operator observes σ_{Rₑ} (via a faster relay / private drand node) *before* the witness quorum's frontier reaches Rₑ, it obtains a verifier-valid `<Rₑ` attestation while already knowing the reveal ⇒ last-look grinding with a passing receipt.

**Mitigation + what the verifier/auditor must demand:**
- The measured `server↔witness` skew bound (assumption 5) is a **release blocker, not an open item.** Without an adversarially-measured, bounded skew, Strict Fast is unsound, full stop. (See [`beacon-skew-measurement.md`](beacon-skew-measurement.md).)
- Witnesses must subscribe to drand via **independent low-latency paths the operator does not control or proxy.** If any witness fetches drand *through* TrueRolls infra, the skew bound is meaningless.
- **Recommend Conservative-at-launch** (minutes-scale Δ + periodic on-chain anchor) which makes the upper bound robust to skew. Gate Strict Fast behind the published skew measurement + external audit. The design defaults to "Fast B", an auditor should push back toward Conservative until the skew report exists.
- Verifier must check the lower bound cryptographically (σ verifies under the pinned group key, root binds σ) and surface the upper bound as a *trust claim conditioned on the deployment's skew measurement*, never as a protocol property.

### 5. Inclusion-proof withholding & proof-confusion (offline verifier obligations), MEDIUM
**Mechanism (design §6 checks 5-7, §7, RFC 6962 leaf prefix `0x00`, node prefix `0x01`).** What the `kd-receipt` v2 verifier MUST check, with the gaps flagged:
- **RFC 6962 leaf/node domain separation** (`0x00`/`0x01` prefixes) in **both** the batch Merkle tree and the log tree. The design says "RFC 6962 hashing" but does not spell out the prefix bytes in the verifier procedure, make checks 5/6 explicit, else a crafted interior node could be presented as a leaf (the exact second-preimage attack 6962 prevents).
- **The two proofs must not be conflated** (design §7 calls this a verifier-confusion bug): `batch_inclusion_proof` (leaf_i → `batch_root`) and `log_inclusion_proof` (commit_leaf → `checkpoint.root_hash`) verify against **different roots**. The impl must enforce distinct root arguments so a valid log-inclusion can't masquerade as batch-membership.
- **Index/size binding:** an inclusion proof is sound only for the claimed index in a tree of the claimed size. Check 5 omits an explicit `leaf_index < tree_size` / index-consistency check, add it.
- **Cosignature binding (check 7):** require `payload.checkpoint_hash == SHA256(JCS(checkpoint))` and `payload.commit_leaf == commit_leaf` so a cosignature over an unrelated checkpoint isn't counted toward k. Design check 7 already states this, confirmed sound.

**Goldens the unwritten verifier needs:** (a) feed a node hash as a leaf → must reject via prefix, (b) swap the two inclusion proofs → must reject, (c) cosignature whose `commit_leaf` differs → must not count toward k, (d) `leaf_index >= tree_size` → must reject.

*Citation: RFC 6962, https://www.rfc-editor.org/rfc/rfc6962 (leaf/node prefixes, "domain separation required for second-preimage resistance").*

### 6. Multi-candidate grinding via double-commit (global invariant), MEDIUM
**Mechanism (design §1, §5.3(b), §5.4, §6).** drand forces commits into the public log but **no per-receipt check (1-13) proves no *other* witnessed commit exists for the same epoch.** An operator can commit two batches for epoch e (different accepted subsets), observe σ_Rₑ, and serve each player the receipt from whichever batch favored the house. Both receipts pass per-receipt checks individually. Only a monitor doing a complete log scan over the epoch's checkpoint range catches it.

**Mitigation + verifier checks:** "one-commit-per-epoch" is a **global** invariant that requires an external monitor attestation (or a complete client-side log scan), it cannot live in per-receipt verification. The verifier output must distinguish **"receipt-local VALID"** from **"globally consistent (monitor-confirmed)"** as separate verdict tiers, so a UI can never present the weaker check as the stronger fairness guarantee. (See also withholding 1(b): the monitor must also forbid void-and-retry on the same accepted set.)

### 7. C2SP cosignature carries no native drand frontier (standards gap), HIGH
**Mechanism (design §5.2/§6 check 8, C2SP tlog-cosignature).** A standard C2SP/`tlog-witness` v1 cosignature signs `cosignature/v1\ntime <POSIX>\n<checkpoint body>`, the only temporal datum is the witness's **self-asserted POSIX wall-clock timestamp**, exactly the "telemetry, not proof" value the design rejects. The design's entire anti-backdating upper bound rests on each witness *also* signing an `observed_drand:{round, sigma, chain_hash}` field, which is **NOT in the standard.** Consequence: off-the-shelf witnesses (transparency-dev/witness, Sigsum, the dev TrustFabric set) will not produce it, the cosignature *format* is reusable but the drand-frontier *attestation semantics* are bespoke and unaudited. The "reuse the mature C2SP witness ecosystem" framing is weaker than it reads.

**Mitigation:** state explicitly that Strict Fast requires a **custom witness attestation beyond C2SP v1**, that no existing public witness provides it, and add it to the external-audit scope. Until then the only standards-conformant upper bound is the self-timestamp (Conservative tier, coarse Δ) or an external chain anchor.

*Citation: C2SP tlog-cosignature, https://github.com/C2SP/C2SP/blob/main/tlog-cosignature.md*

## Auditability: "root published before round resolved"

This is the anti-backdating (upper-bound) guarantee. The lower bound is cryptographic and free (root binds σ_{R'ₑ}). The upper bound is irreducibly a trust claim. Options and tradeoffs:

| Mechanism | What it proves | Tradeoff |
|-----------|----------------|----------|
| **Witness self-timestamp (C2SP v1)** | Witness asserts a wall-clock time | Self-asserted telemetry, not proof; coarse Δ only (Conservative). Standards-conformant today. |
| **Custom `observed_drand` cosignature** (design's Strict Fast) | Quorum's drand frontier was < Rₑ at signing | Tight bound, but **non-standard** (finding 7); requires custom witnesses; only as good as the measured beacon-view-skew bound (finding 4); skew measurement is a release blocker. |
| **Periodic on-chain anchor (T2, e.g. Bitcoin/OpenTimestamps)** | The log *root* existed by a block time; no equivocation across the anchored range | ~±2h consensus slop + 10-min blocks ⇒ **too coarse for a 3-second drand period** unless Δ is minutes. Backstops equivocation/witness-collusion, **NOT** fast-mode backdating. Never conflate "anchored to Bitcoin" with "fast-mode fair." |
| **Per-batch on-chain settlement (T3)** | Per-batch existence at a block | Correctly deprecated in the design as rarely justified (cost/latency). |
| **RFC 6962-style transparency log + independent monitors** | Append-only consistency; equivocation publicly provable after the fact | Detection only (out-of-band gossip), not real-time prevention; needs independent-path monitors (finding 2). |

**Recommended posture:** launch **Conservative** (minutes-Δ + periodic T2 anchor + k-of-n witnesses with independent drand paths + ≥1 independent-path monitor with one-commit-per-epoch enforcement). Gate **Strict Fast** behind (i) a published, adversarially-measured beacon-view-skew bound, (ii) the explicit acknowledgment that `observed_drand` is a custom witness attestation, and (iii) external audit of that attestation. Until then the verifier should emit two distinct verdict tiers, receipt-local VALID vs globally-monitor-confirmed, and the UI must never present the former as full fairness.

## Unverified / flagged

- **C2SP cosignature maturity tag.** The fetched spec referenced "v1" but no `rc` tag was visible, the design's §9.5 claim of "v1.0.0-rc.1 (release candidate, not frozen)" is plausible but unconfirmed, verify against C2SP repo tags before relying on stability.
- **No batch/Merkle code exists in the repo**, all `kd-receipt` v2 findings concern code to be written.
- **drand quicknet timing/skew numbers were not independently re-derived.** Assumption 5's skew bound is unmeasured (the design's own open item) and is the single largest unproven load-bearing claim for Strict Fast.

**Net assessment:** `v2-fairness-protocol.md` is a strong, honest threat model that already anticipates the major attack classes and correctly refuses a trustless claim. This audit's value-add is four sharpenings, (1) `observed_drand` is non-standard, no off-the-shelf witness provides it. (2) Beacon-view-skew measurement is a release blocker, recommend Conservative-at-launch. (3) Manifest availability is an unsolved data-availability problem needing signed void reason-codes and a same-set-on-retry invariant. (4) Global one-commit-per-epoch needs an explicit verdict tier so monitor-unconfirmed VALID is never shown as full fairness, plus the explicit RFC 6962 prefix/index/proof-confusion goldens for the unwritten `kd-receipt` v2 verifier.

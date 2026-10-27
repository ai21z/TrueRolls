# TrueRolls Verifier-Use Grant

Version 1.0, 2026-07-11

Copyright (c) 2025 Vissarion Zounarakis.

This is a narrow, source-available verifier license. It is not an open-source license. It exists so
players, studios, bots, auditors, and modders can independently verify TrueRolls receipts and
integrate that verification into their own tools without obtaining separate permission.

## 1. Definitions

**Verification Purpose** means checking an already-created TrueRolls receipt, reproducing its
documented verification checks, testing verifier interoperability, or integrating those checks into
a product that consumes TrueRolls receipts. Replaying an existing receipt's deterministic math and
sampling is part of the Verification Purpose. Creating an outcome, minting or signing a receipt, or
operating a roll service is not.

**Verifier Materials** means only the following repository paths and their contents:

- `crates/kd-core/`, `crates/kd-drand/`, `crates/kd-receipt/`, and `crates/kd-core-wasm/`, solely as
  required for the Verification Purpose;
- `crates/kd-cli/`, solely to build, run, modify, or distribute the `kd verify` functionality;
- the generated browser package under `packages/kd-core-wasm/`;
- `docs/receipt-format.md`, `docs/verifying.md`, `docs/claims.md`, and `docs/threat-model.md`;
- receipt fixtures matching `goldens/golden_receipt_*.json`, plus `goldens/README.md` and
  `goldens/goldens.csv`;
- `scripts/wasm-package-paths.mjs`, `scripts/wasm-receipt-parity.mjs`, and
  `scripts/generate-browser-fixtures.mjs`; and
- root build metadata (`Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, and `.cargo/config.toml`)
  only as needed to build or test the Verifier Materials.

The listed Rust crates and compiled CLI/WASM artifacts contain some non-verifier interfaces because
the verifier shares the same deterministic engine as the issuer. Those interfaces are included in
the copied build closure, but this grant authorizes their use only for the Verification Purpose.
Third-party dependencies remain under their respective licenses.

## 2. Grant

Subject to this license, you may use, copy, modify, create derivative works from, and distribute the
Verifier Materials in source or compiled form solely for the Verification Purpose. This includes
embedding the verifier in games, bots, audit tools, websites, and other products that consume
TrueRolls receipts.

Every distributed copy or derivative must:

1. include this license and the applicable copyright notices;
2. identify files you materially changed;
3. preserve receipt provenance and claim-boundary notices; and
4. make clear that a modified verifier is not an official TrueRolls verifier unless the copyright
   holder has separately authorized that claim.

Recipients of a compliant distribution receive the same rights directly under this license. No
separate sublicense is granted or required.

## 3. Rights Not Granted

This license does not grant permission to:

- use the Verifier Materials to create random outcomes, mint or sign receipts, or operate a roll or
  receipt-issuing service;
- invoke or distribute `kd roll`, receipt-signing interfaces, `kd-api`, `kd-worker-wasm`, or any
  server/minting functionality for a purpose other than compiling the permitted verifier closure;
- issue receipts that claim to be official TrueRolls receipts;
- use or obtain TrueRolls production signing keys;
- copy, modify, publish, or distribute `services/loom-demo/`, server code, artwork, visual assets, or
  any repository material not expressly listed as Verifier Materials;
- use the TrueRolls name, logos, or marks except for accurate descriptive reference to compatible
  receipts or the origin of unmodified Verifier Materials; or
- remove or misrepresent copyright, license, provenance, or claim-boundary notices.

All rights not expressly granted remain reserved. Separate written permission may be available from
`aris@zounarakis.com`.

## 4. No Warranty

THE VERIFIER MATERIALS ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
NONINFRINGEMENT. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER
LIABILITY ARISING FROM, OUT OF, OR IN CONNECTION WITH THE VERIFIER MATERIALS OR THEIR USE.

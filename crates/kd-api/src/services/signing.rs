//! Ed25519 receipt signing — re-exported from the shared `kd-receipt` crate.
//!
//! The signer implementation lives in `kd_receipt` alongside the verifier so both
//! share ONE JCS canonicalization (`kd_receipt::canonical_signing_bytes`) and can
//! never drift: SIG-1 closed the verify side (kd-api delegates `POST /v1/verify`
//! to `kd_receipt`); this closes the sign side. This module is a thin re-export so
//! existing kd-api call sites (`crate::services::signing::*`) and the SIG-2 boot
//! guard keep working unchanged.

pub use kd_receipt::{PublicKeyEntry, ReceiptSignature, ReceiptSigner, reject_test_signer_in_prod};

#[cfg(test)]
pub use kd_receipt::PUBLISHED_TEST_SEED_HEX;

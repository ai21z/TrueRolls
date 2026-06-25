//! kd-core: pure math for TrueRolls (spec v1.3.1)
//!
//! Implements the Baseline/Methods math summarized in the unified spec:
//! - Standardized face scores g(i)
//! - Logits z_i = λ·κ·g(i) and softmax
//! - Guarded mixing toward uniform: p(α) = (1−α)·p̃ + α·u
//! - Pick the **minimal α** that passes both caps (KL in nats, EV vs SD_u)
//! - Apply ε-floor **before** renormalization when evaluating caps
//! - Deterministic inverse-CDF sampling helper (behind feature "rand")
//!
//! No I/O, no RNG selection, no HTTP/DB concerns.

pub mod errors;
pub use errors::CoreError;
pub mod die;
pub mod distribution;
pub mod guards;
pub mod math;
pub mod params;

#[cfg(feature = "rand")]
pub mod sample;

/// Version tag for kd-core math params (echo this in transcripts).
pub const PARAM_VERSION: &str = "roll.math.v1";

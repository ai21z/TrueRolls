//! Sampling helpers (optional).
//! Provide your own RNG (e.g., ChaCha20 in kd-api). We expose:
//! - inverse-CDF from a `u64`
//! - sample_index from probs using RngCore

use crate::die::Die;
use crate::distribution::{Output, compute_distribution};
use crate::params::Params;
use rand_core::RngCore;

/// Deterministic mapping from a 64-bit draw to an index by prefix-CDF.
/// No modulo bias, monotone in the fixed-point sense.
pub fn prefix_cdf_index_from_u64<const N: usize>(p: &[f64; N], draw: u64) -> usize {
    // Uniform in [0,1) using the exact 2^64 bucket count, written as MAX + 1.
    let u = (draw as f64) / ((u64::MAX as f64) + 1.0);
    let mut acc = 0.0;
    for (i, &pi) in p.iter().enumerate() {
        acc += pi;
        if u < acc {
            return i;
        }
    }
    N - 1
}

/// Sample index using any RngCore (inverse-CDF).
pub fn sample_index_from_probs<const N: usize>(p: &[f64; N], rng: &mut impl RngCore) -> usize {
    let u64draw = rng.next_u64();
    prefix_cdf_index_from_u64::<N>(p, u64draw)
}

/// Full compute+sample using caller-provided RNG.
pub fn compute_roll<const N: usize>(
    die: Die<N>,
    kappa: f64,
    params: &Params,
    rng: &mut impl RngCore,
) -> Result<(u32, Output<N>), crate::errors::CoreError> {
    let out = compute_distribution::<N>(die, kappa, params)?;
    let idx = sample_index_from_probs::<N>(&out.probs, rng);
    Ok(((idx + 1) as u32, out))
}

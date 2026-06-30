//! Guard solver per v1.3.1:
//! - Mix toward uniform: p(α) = (1−α)·p̃ + α·u
//! - Choose the **minimal α** such that BOTH caps hold, measured AFTER ε-floor + renorm.
//!   We do a single monotone bisection on the joint predicate (EV&KL).

use crate::die::Die;
use crate::math::{dkl_to_uniform, ev, floor_and_renorm_eps};
use crate::params::Params;

/// Mix with uniform in the v1.3.1 direction.
#[inline]
fn mix_with_uniform<const N: usize>(p_tilde: &[f64; N], alpha: f64) -> [f64; N] {
    let n_inv = 1.0 / (N as f64);
    let one_minus = 1.0 - alpha;
    let mut out = [0.0; N];
    for i in 0..N {
        // p(α) = (1−α)·p̃ + α·u
        out[i] = one_minus * p_tilde[i] + alpha * n_inv;
    }
    out
}

/// Check caps (EV & KL) after ε-floor+renorm, return (ok, ev, kl).
#[inline]
fn guards_ok<const N: usize>(p: &[f64; N], params: &Params) -> (bool, f64, f64) {
    let mu = Die::<N>::ev_uniform();
    let sd = Die::<N>::sd_uniform();
    let ev_p = ev::<N>(p);
    let kl_p = dkl_to_uniform::<N>(p);
    // Small slack on KL for FP noise. EV bound is tight using the same epsilon-renormed p.
    let ev_ok = (ev_p - mu).abs() <= params.ev_cap_sd * sd;
    let kl_ok = kl_p <= params.kl_cap_nats + 1e-15;
    (ev_ok && kl_ok, ev_p, kl_p)
}

/// Minimal α via unified bisection on BOTH constraints (measured after ε-floor+renorm).
/// Always succeeds because α=1 yields uniform (feasible).
pub fn apply_guards_min_alpha<const N: usize>(
    p_tilde: &[f64; N],
    params: &Params,
) -> Result<(f64, [f64; N], f64, f64), crate::errors::CoreError> {
    if !params.validate() {
        return Err(crate::errors::CoreError::NonFiniteInput);
    }

    // Quick check: α = 0
    {
        let p0 = floor_and_renorm_eps::<N>(mix_with_uniform::<N>(p_tilde, 0.0), params.epsilon);
        let (ok0, ev0, kl0) = guards_ok::<N>(&p0, params);
        if ok0 {
            return Ok((0.0, p0, ev0, kl0));
        }
    }

    // Bisection in [0,1] for minimal feasible α.
    let mut lo = 0.0_f64; // infeasible
    let mut hi = 1.0_f64; // feasible (uniform)
    let mut iters = 0_u32;

    while (hi - lo) > params.alpha_tol && iters < params.alpha_max_iters {
        let mid = 0.5 * (lo + hi);
        let pmid = floor_and_renorm_eps::<N>(mix_with_uniform::<N>(p_tilde, mid), params.epsilon);
        let (ok, _ev_mid, _kl_mid) = guards_ok::<N>(&pmid, params);
        if ok {
            // Feasible at mid → try smaller α.
            hi = mid;
        } else {
            // Infeasible at mid → need more uniform (increase α).
            lo = mid;
        }
        iters += 1;
    }

    // hi is the minimal feasible α within tolerance.
    let alpha = hi.clamp(0.0, 1.0);
    let p = floor_and_renorm_eps::<N>(mix_with_uniform::<N>(p_tilde, alpha), params.epsilon);
    let (ok, ev_p, kl_p) = guards_ok::<N>(&p, params);
    if !ok {
        return Err(crate::errors::CoreError::SearchFailed);
    }
    Ok((alpha, p, ev_p, kl_p))
}

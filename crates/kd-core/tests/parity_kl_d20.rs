//! KD-011 - Parity thin-slice: KL-cap PASS/FAIL for d20 @ λ=0.6
//!
//! Verifies the guarded-distribution invariants hold across all κ values:
//!   1. Theoretical: KL(p || uniform) ≤ cap, |EV(p) − EV_u| ≤ cap for all κ
//!   2. Empirical: seeded Monte Carlo → empirical frequencies are consistent
//!      with the theoretical distribution (χ² goodness-of-fit)
//!
//! All assertions are PASS/FAIL only - no numeric values in test output.
//! Runtime target: <60s CI (actual: <5s).

use kd_core::{
    die::Die,
    distribution::compute_distribution,
    math::{dkl_to_uniform, ev as compute_ev},
    params::{Params, default_for_die},
    sample::compute_roll,
};
use rand::SeedableRng;
use rand_chacha::ChaCha20Rng;

// ---------------------------------------------------------------------------
// Helpers - PASS/FAIL only, no numbers leaked
// ---------------------------------------------------------------------------

/// Assert a boolean with a label-only message (no numeric details).
macro_rules! pass_fail {
    ($cond:expr, $label:expr) => {
        assert!($cond, "FAIL: {}", $label);
    };
}

/// Build test params: d20 defaults but with λ=0.6 (the thin-slice config).
fn test_params() -> Params {
    let mut p = default_for_die(20);
    p.lambda = 0.6;
    p
}

/// Linearly-spaced κ values from -1.0 to 1.0 inclusive, n_steps+1 points.
fn kappa_sweep(n_steps: usize) -> Vec<f64> {
    (0..=n_steps)
        .map(|i| -1.0 + 2.0 * (i as f64) / (n_steps as f64))
        .collect()
}

// ---------------------------------------------------------------------------
// Test 1: Theoretical cap invariants across full κ sweep
// ---------------------------------------------------------------------------

#[test]
fn theoretical_caps_hold_all_kappa() {
    let params = test_params();
    let mu = Die::<20>::ev_uniform();
    let sd = Die::<20>::sd_uniform();
    let kl_cap = params.kl_cap_nats;
    let ev_bound = params.ev_cap_sd * sd;
    let tol = 1e-12;

    // Sweep 201 κ values: -1.00, -0.99, ..., 0.99, 1.00
    for kappa in kappa_sweep(200) {
        let out = compute_distribution::<20>(Die::<20>, kappa, &params)
            .expect("FAIL: compute_distribution returned Err");

        // Probs sum to 1
        let sum: f64 = out.probs.iter().sum();
        pass_fail!((sum - 1.0).abs() < tol, "probs_sum_to_one");

        // All probs non-negative
        pass_fail!(out.probs.iter().all(|&p| p >= 0.0), "probs_non_negative");

        // KL cap
        pass_fail!(out.kl <= kl_cap + tol, "kl_within_cap");

        // EV cap
        pass_fail!((out.ev - mu).abs() <= ev_bound + tol, "ev_within_cap");

        // Alpha in [0, 1]
        pass_fail!(
            out.alpha >= 0.0 && out.alpha <= 1.0,
            "alpha_in_unit_interval"
        );

        // Cross-check: recompute KL and EV from probs independently
        let kl_check = dkl_to_uniform::<20>(&out.probs);
        let ev_check = compute_ev::<20>(&out.probs);
        pass_fail!((kl_check - out.kl).abs() < tol, "kl_self_consistent");
        pass_fail!((ev_check - out.ev).abs() < tol, "ev_self_consistent");
    }
}

// ---------------------------------------------------------------------------
// Test 2: κ=0 yields exact uniform (no guard needed)
// ---------------------------------------------------------------------------

#[test]
fn kappa_zero_is_uniform_lambda_06() {
    let params = test_params();
    let out = compute_distribution::<20>(Die::<20>, 0.0, &params)
        .expect("FAIL: compute_distribution returned Err");

    let uniform = 1.0 / 20.0;
    for &pi in &out.probs {
        pass_fail!((pi - uniform).abs() < 1e-12, "kappa0_uniform_probs");
    }
    pass_fail!(out.alpha == 0.0, "kappa0_alpha_zero");
    pass_fail!(out.kl < 1e-12, "kappa0_kl_zero");
}

// ---------------------------------------------------------------------------
// Test 3: Symmetry - positive and negative κ produce mirrored distributions
// ---------------------------------------------------------------------------

#[test]
fn kappa_symmetry() {
    let params = test_params();
    let mu = Die::<20>::ev_uniform();

    for &kappa in &[0.1, 0.3, 0.5, 0.7, 0.9, 1.0] {
        let pos = compute_distribution::<20>(Die::<20>, kappa, &params).unwrap();
        let neg = compute_distribution::<20>(Die::<20>, -kappa, &params).unwrap();

        // Alpha should be identical (same |κ|)
        pass_fail!((pos.alpha - neg.alpha).abs() < 1e-9, "symmetry_alpha");

        // KL should be identical (KL depends on |κ|)
        pass_fail!((pos.kl - neg.kl).abs() < 1e-12, "symmetry_kl");

        // EV should be mirrored around μ_u
        pass_fail!(
            ((pos.ev - mu) + (neg.ev - mu)).abs() < 1e-12,
            "symmetry_ev_mirrored"
        );

        // Probs should be reversed
        for i in 0..20 {
            pass_fail!(
                (pos.probs[i] - neg.probs[19 - i]).abs() < 1e-12,
                "symmetry_probs_reversed"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Test 4: Monotonicity - alpha is non-decreasing with |κ|
// ---------------------------------------------------------------------------

#[test]
fn alpha_monotone_with_kappa_magnitude() {
    let params = test_params();
    let mut prev_alpha = 0.0_f64;

    for kappa in kappa_sweep(100).into_iter().filter(|&k| k >= 0.0) {
        let out = compute_distribution::<20>(Die::<20>, kappa, &params).unwrap();
        pass_fail!(out.alpha >= prev_alpha - 1e-9, "alpha_monotone");
        prev_alpha = out.alpha;
    }
}

// ---------------------------------------------------------------------------
// Test 5: Seeded Monte Carlo - empirical frequencies match theoretical probs
// ---------------------------------------------------------------------------

#[test]
fn empirical_monte_carlo_seeded() {
    let params = test_params();
    let n_samples: usize = 100_000;

    // Representative κ values spanning the full range
    let kappas: [f64; 9] = [-1.0, -0.7, -0.4, -0.2, 0.0, 0.2, 0.4, 0.7, 1.0];

    for &kappa in &kappas {
        // Deterministic seed: mix kappa bits into seed for variety per κ,
        // but still fully deterministic.
        let seed_base: u64 = 0xDEAD_BEEF_CAFE_0011;
        let seed = seed_base ^ (kappa.to_bits());
        let mut rng = ChaCha20Rng::seed_from_u64(seed);

        // Get theoretical distribution
        let out = compute_distribution::<20>(Die::<20>, kappa, &params).unwrap();

        // Sample n_samples rolls
        let mut counts = [0_u64; 20];
        for _ in 0..n_samples {
            let (face, _) = compute_roll::<20>(Die::<20>, kappa, &params, &mut rng).unwrap();
            counts[(face - 1) as usize] += 1;
        }

        // χ² goodness-of-fit test against theoretical probs.
        // Under H0 (samples from p), χ² ~ χ²(19).
        // Reject at p < 1e-6 (χ²₁₉ > 59.95) - extremely conservative
        // to avoid false failures in CI.
        let chi2_crit = 60.0; // well above 99.9999th percentile of χ²(19)
        let mut chi2 = 0.0_f64;
        for (&count, &prob) in counts.iter().zip(out.probs.iter()) {
            let observed = count as f64;
            let expected = prob * (n_samples as f64);
            if expected > 0.0 {
                chi2 += (observed - expected).powi(2) / expected;
            }
        }
        pass_fail!(chi2 < chi2_crit, "chi2_goodness_of_fit");
    }
}

// ---------------------------------------------------------------------------
// Test 6: Sampling determinism - same seed produces same faces
// ---------------------------------------------------------------------------

#[test]
fn sampling_determinism() {
    let params = test_params();
    let kappa = 0.6;
    let seed = 0xCAFE_BABE_1234_5678_u64;

    let mut rng1 = ChaCha20Rng::seed_from_u64(seed);
    let mut rng2 = ChaCha20Rng::seed_from_u64(seed);

    for _ in 0..1000 {
        let (face1, _) = compute_roll::<20>(Die::<20>, kappa, &params, &mut rng1).unwrap();
        let (face2, _) = compute_roll::<20>(Die::<20>, kappa, &params, &mut rng2).unwrap();
        pass_fail!(face1 == face2, "deterministic_sampling");
    }
}

// ---------------------------------------------------------------------------
// Test 7: Edge κ - extreme values still satisfy caps
// ---------------------------------------------------------------------------

#[test]
fn extreme_kappa_caps_hold() {
    let params = test_params();
    let mu = Die::<20>::ev_uniform();
    let sd = Die::<20>::sd_uniform();
    let tol = 1e-12;

    for &kappa in &[-1.0, 1.0, -0.999, 0.999] {
        let out = compute_distribution::<20>(Die::<20>, kappa, &params).unwrap();
        pass_fail!(out.kl <= params.kl_cap_nats + tol, "extreme_kl_cap");
        pass_fail!(
            (out.ev - mu).abs() <= params.ev_cap_sd * sd + tol,
            "extreme_ev_cap"
        );
        // At extreme κ with λ=0.6, guards MUST be active
        pass_fail!(out.alpha > 0.0, "extreme_guards_active");
    }
}

// ---------------------------------------------------------------------------
// Test 8: λ=0.6 produces stronger tilt than default λ=0.5
// ---------------------------------------------------------------------------

#[test]
fn lambda_06_stronger_tilt_than_default() {
    let params_06 = test_params(); // λ=0.6
    let params_05 = default_for_die(20); // λ=0.5

    for &kappa in &[0.3, 0.5, 0.7, 1.0] {
        let out_06 = compute_distribution::<20>(Die::<20>, kappa, &params_06).unwrap();
        let out_05 = compute_distribution::<20>(Die::<20>, kappa, &params_05).unwrap();

        // λ=0.6 should need equal or more guarding (higher α)
        pass_fail!(
            out_06.alpha >= out_05.alpha - 1e-9,
            "stronger_lambda_needs_more_guard"
        );
    }
}

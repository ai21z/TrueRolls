//! Property test for target #2: the minimal guard weight α chosen by
//! `apply_guards_min_alpha` is **monotone non-decreasing in |κ|**, across EVERY
//! supported die. This closes the "asserted-not-proven" gap empirically; the
//! analytic proof (the comonotone-covariance / Chebyshev argument) lives in
//! `docs/explanation/alpha-monotonicity.md`.
//!
//! Why it holds (sketch): the feasible α-set is `[α*, 1]` — mixing toward
//! uniform lowers both `KL(p‖u)` (convex in α, min at α=1) and `|EV−μ|` (linear
//! in α) — so the minimal α is the binding threshold. At any fixed α, both
//! `KL(p(α,κ)‖u)` and `|EV(p(α,κ))−μ|` are non-decreasing in |κ| (each a
//! covariance of two comonotone functions of the face score), so the threshold
//! itself rises with |κ|. The ε-floor+renorm is a small monotonicity-preserving
//! perturbation, confirmed here to within `tol`.

use kd_core::die::Die;
use kd_core::distribution::compute_distribution_with_defaults;

/// Sweep κ from 0 outward to +1 and to −1 and assert α never decreases as |κ|
/// grows. `tol` absorbs the bisection granularity (`params.alpha_tol = 1e-9`)
/// and ε-floor jitter; it is orders of magnitude below any real (~1e-2)
/// inter-grid decrease, so it cannot mask a genuine violation.
fn assert_alpha_monotone<const N: usize>(steps: u32, tol: f64) {
    for sign in [1.0_f64, -1.0_f64] {
        let mut prev = compute_distribution_with_defaults(Die::<N>, 0.0)
            .unwrap()
            .alpha;
        for k in 1..=steps {
            let kappa = sign * (k as f64) / (steps as f64);
            let alpha = compute_distribution_with_defaults(Die::<N>, kappa)
                .unwrap()
                .alpha;
            assert!(
                alpha >= prev - tol,
                "d{N}: α dropped as |κ| rose — α({kappa:.5}) = {alpha} < prev = {prev}"
            );
            prev = alpha;
        }
    }
}

#[test]
fn minimal_alpha_monotone_in_kappa_magnitude_all_dice() {
    let steps = 200;
    let tol = 1e-7;
    assert_alpha_monotone::<4>(steps, tol);
    assert_alpha_monotone::<6>(steps, tol);
    assert_alpha_monotone::<8>(steps, tol);
    assert_alpha_monotone::<10>(steps, tol);
    assert_alpha_monotone::<12>(steps, tol);
    assert_alpha_monotone::<20>(steps, tol);
    assert_alpha_monotone::<100>(steps, tol);
}

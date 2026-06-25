#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

/// Tunable parameters per spec v1.3.1
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// KL cap in nats: KL(p || u) ≤ kl_cap_nats
    pub kl_cap_nats: f64,
    /// EV cap: |EV(p) − EV_u| ≤ ev_cap_sd * SD_u
    pub ev_cap_sd: f64,
    /// Numerical floor ε before renormalization
    pub epsilon: f64,
    /// α bisection tolerance and max iterations (for KL bound)
    pub alpha_tol: f64,
    pub alpha_max_iters: u32,
    /// Logit scale λ in z_i = λ·κ·g(i)
    pub lambda: f64,
}

impl Params {
    pub fn validate(&self) -> bool {
        let finite = self.kl_cap_nats.is_finite()
            && self.ev_cap_sd.is_finite()
            && self.epsilon.is_finite()
            && self.alpha_tol.is_finite()
            && self.lambda.is_finite();
        let sane = self.kl_cap_nats >= 0.0
            && self.ev_cap_sd >= 0.0
            && self.epsilon > 0.0
            && self.alpha_tol > 0.0
            && self.alpha_max_iters > 0;
        finite && sane
    }
}

/// Defaults exactly as v1.3.1 (λ=0.50, ε=1e-12; die-specific KL caps; EV cap = 0.20·SD_u).
pub fn default_for_die(n: usize) -> Params {
    // Clamp to at least 2 so ln(n) is well-defined for the heuristic branch.
    let n_f = (n.max(2)) as f64;

    let kl: f64 = match n {
        6 => 0.060_f64,
        20 => 0.035_f64,
        100 => 0.025_f64,
        _ => 0.030_f64.min(0.5_f64 / n_f.ln()), // simple heuristic for other sizes
    };

    Params {
        kl_cap_nats: kl,
        ev_cap_sd: 0.20_f64,
        epsilon: 1e-12_f64,
        alpha_tol: 1e-9_f64,
        alpha_max_iters: 64,
        lambda: 0.50_f64,
    }
}

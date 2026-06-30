use crate::die::Die;
use crate::errors::CoreError;
use crate::guards::apply_guards_min_alpha;
use crate::math::softmax_stable;
use crate::params::{Params, default_for_die};

#[derive(Clone, Debug)]
pub struct Output<const N: usize> {
    /// Final guarded probabilities (ε-floor + renorm applied).
    pub probs: [f64; N],
    /// Minimal α chosen by guards (weight toward uniform).
    pub alpha: f64,
    /// KL(probs || uniform).
    pub kl: f64,
    /// EV(probs) under faces 1..=N.
    pub ev: f64,
    /// True if α>0 (non-uniform mix applied).
    pub guards_applied: bool,
}

#[cfg(feature = "serde")]
mod serde_impls {
    use super::Output;
    use serde::{Deserialize, Deserializer, Serialize, Serializer, ser::SerializeStruct};

    // Serialize Output<N> manually. Probs is emitted as a sequence.
    impl<const N: usize> Serialize for Output<N> {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            let mut st = serializer.serialize_struct("Output", 5)?;
            st.serialize_field("probs", &self.probs.as_slice())?; // &[f64]
            st.serialize_field("alpha", &self.alpha)?;
            st.serialize_field("kl", &self.kl)?;
            st.serialize_field("ev", &self.ev)?;
            st.serialize_field("guards_applied", &self.guards_applied)?;
            st.end()
        }
    }

    // Helper for deserializing, use Vec<f64> then copy into [f64; N]
    #[derive(Deserialize)]
    struct OutputHelper {
        probs: Vec<f64>,
        alpha: f64,
        kl: f64,
        ev: f64,
        guards_applied: bool,
    }

    impl<'de, const N: usize> Deserialize<'de> for Output<N> {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            use serde::de::Error as DeError;

            let helper = OutputHelper::deserialize(deserializer)?;
            if helper.probs.len() != N {
                return Err(D::Error::invalid_length(
                    helper.probs.len(),
                    &format!("expected {} probabilities", N).as_str(),
                ));
            }
            let mut probs = [0.0_f64; N];
            probs.copy_from_slice(&helper.probs[..]);
            Ok(Output {
                probs,
                alpha: helper.alpha,
                kl: helper.kl,
                ev: helper.ev,
                guards_applied: helper.guards_applied,
            })
        }
    }
}

/// Build tilted distribution then guard it with **minimal α** per v1.3.1.
/// - kappa: behavior stance [-1,1]
/// - params: use `default_for_die(N)` for current defaults
pub fn compute_distribution<const N: usize>(
    _die: Die<N>,
    kappa: f64,
    params: &Params,
) -> Result<Output<N>, CoreError> {
    if !kappa.is_finite() || !params.validate() {
        return Err(CoreError::NonFiniteInput);
    }
    // κ is a stance in [-1, 1] by the math contract. Reject out-of-range κ here,
    // the single place both the signer (kd-api) and the offline verifier
    // (kd-receipt) route through, so neither can bless a κ outside the contract.
    // A κ=50 receipt is therefore refused, not verified VALID. Bounds inclusive.
    if !(-1.0..=1.0).contains(&kappa) {
        return Err(CoreError::KappaOutOfRange(kappa));
    }
    if N < 2 {
        return Err(CoreError::InvalidDieSize(N));
    }

    // 1) logits = λ·κ·g(i)
    let g = Die::<N>::face_scores_unitvar();
    let mut logits = [0.0f64; N];
    let scale = params.lambda * kappa;
    for i in 0..N {
        logits[i] = scale * g[i];
    }

    // 2) p̃ = softmax(logits)
    let p_tilde = softmax_stable::<N>(&logits);

    // 3) minimal-α guard toward uniform
    let (alpha, p, ev, kl) = apply_guards_min_alpha::<N>(&p_tilde, params)?;

    Ok(Output {
        probs: p,
        alpha,
        kl,
        ev,
        guards_applied: alpha > 0.0,
    })
}

/// Convenience with per-die defaults.
pub fn compute_distribution_with_defaults<const N: usize>(
    die: Die<N>,
    kappa: f64,
) -> Result<Output<N>, CoreError> {
    let params = default_for_die(N);
    compute_distribution::<N>(die, kappa, &params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::{dkl_to_uniform, ev};
    use crate::params::default_for_die;

    #[test]
    fn kappa_zero_is_uniform_d20() {
        let out = compute_distribution_with_defaults(Die::<20>, 0.0).unwrap();
        let u = 1.0 / 20.0;
        for &pi in &out.probs {
            assert!((pi - u).abs() < 1e-12);
        }
        assert!(out.kl < 1e-12);
        assert!((out.ev - Die::<20>::ev_uniform()).abs() < 1e-12);
    }

    #[test]
    fn sums_to_one_and_caps_hold_d6() {
        let params = default_for_die(6);
        let out = compute_distribution(Die::<6>, 0.7, &params).unwrap();
        let sum: f64 = out.probs.iter().sum();
        assert!((sum - 1.0).abs() < 1e-12);
        // caps respected
        let mu = Die::<6>::ev_uniform();
        let sd = Die::<6>::sd_uniform();
        assert!((out.ev - mu).abs() <= params.ev_cap_sd * sd + 1e-12);
        assert!(out.kl <= params.kl_cap_nats + 1e-12);
        // sanity: recompute metrics agree
        let ev2 = ev::<6>(&out.probs);
        let kl2 = dkl_to_uniform::<6>(&out.probs);
        assert!((ev2 - out.ev).abs() < 1e-12);
        assert!((kl2 - out.kl).abs() < 1e-12);
    }

    #[test]
    fn alpha_in_01_and_not_increasing_with_kappa_magnitude() {
        let p = default_for_die(100);
        let a_small = compute_distribution(Die::<100>, 0.2, &p).unwrap().alpha;
        let a_big = compute_distribution(Die::<100>, 0.9, &p).unwrap().alpha;
        // With more tilt we need >= α to satisfy caps. Minimal α should not decrease.
        assert!(a_big >= a_small - 1e-9);
        assert!(a_small >= 0.0 && a_big <= 1.0);
    }

    #[test]
    fn kappa_out_of_range_is_rejected_bounds_inclusive() {
        // In-contract boundaries are accepted (κ ∈ [-1, 1], inclusive).
        assert!(compute_distribution_with_defaults(Die::<20>, 1.0).is_ok());
        assert!(compute_distribution_with_defaults(Die::<20>, -1.0).is_ok());
        // Out-of-contract κ is rejected. The verifier must never bless it.
        assert!(matches!(
            compute_distribution_with_defaults(Die::<20>, 50.0),
            Err(CoreError::KappaOutOfRange(k)) if k == 50.0
        ));
        assert!(matches!(
            compute_distribution_with_defaults(Die::<20>, 1.000_001),
            Err(CoreError::KappaOutOfRange(_))
        ));
        assert!(matches!(
            compute_distribution_with_defaults(Die::<20>, -1.000_001),
            Err(CoreError::KappaOutOfRange(_))
        ));
    }
}

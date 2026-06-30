//! Thin adapter around kd-core (v1.3.1).
//! - Builds the guarded distribution in kd-core (softmax -> minimal-α mix -> ε-floor + renorm)
//! - Samples a face via inverse-CDF using a caller-supplied RNG (any RngCore)
//! - Builds transcript JSON here (API concern) including param_version

use kd_core::{
    PARAM_VERSION as KD_PARAM_VERSION,
    die::Die,
    distribution::{Output, compute_distribution},
    params::{Params, default_for_die},
    sample::prefix_cdf_index_from_u64,
};
use rand::RngCore;

/// What the route expects. If you already have this type, keep your version
/// and adapt the return mapping below.
pub struct ComputeResult {
    pub face: u32,
    pub draw_u64: u64,
    pub ev: f64,
    pub alpha: f64,
    pub kl: f64,
    pub transcript_json: serde_json::Value,
    #[allow(dead_code)]
    pub param_version: &'static str,
}

/// Helper to dispatch on die string to a const generic.
fn with_die<T>(die: &str, f: impl FnOnce(&'static str) -> anyhow::Result<T>) -> anyhow::Result<T> {
    match die {
        "d6" => f("d6"),
        "d20" => f("d20"),
        "d100" => f("d100"),
        other => anyhow::bail!("unsupported die: {other}"),
    }
}

/// Preferred entrypoint when you want the transcript to record which RNG was used in sampling.
/// `sampling_rng_label` should be something like "HKDF(SHA-256)->ChaCha20Rng".
pub fn compute_roll_with_rng_labeled(
    die: &str,
    kappa: f64,
    rng: &mut impl RngCore,
    params_override: Option<Params>,
    sampling_rng_label: &str,
) -> anyhow::Result<ComputeResult> {
    with_die(die, |d| {
        // Compute guarded distribution with kd-core, then sample face.
        let (idx, draw_u64, out): (usize, u64, OutAny) = match d {
            "d6" => {
                let params = params_override.unwrap_or_else(|| default_for_die(6));
                let out: Output<6> = compute_distribution::<6>(Die::<6>, kappa, &params)?;
                let draw = rng.next_u64();
                let idx = prefix_cdf_index_from_u64::<6>(&out.probs, draw);
                (idx, draw, OutAny::D6(out))
            }
            "d20" => {
                let params = params_override.unwrap_or_else(|| default_for_die(20));
                let out: Output<20> = compute_distribution::<20>(Die::<20>, kappa, &params)?;
                let draw = rng.next_u64();
                let idx = prefix_cdf_index_from_u64::<20>(&out.probs, draw);
                (idx, draw, OutAny::D20(out))
            }
            "d100" => {
                let params = params_override.unwrap_or_else(|| default_for_die(100));
                let out: Output<100> = compute_distribution::<100>(Die::<100>, kappa, &params)?;
                let draw = rng.next_u64();
                let idx = prefix_cdf_index_from_u64::<100>(&out.probs, draw);
                (idx, draw, OutAny::D100(out))
            }
            _ => unreachable!(),
        };

        // Map the const-generic Output<N> into plain scalars + Vec for the transcript
        let (ev, alpha, kl, probs_vec) = out.into_parts();

        let face = (idx + 1) as u32;

        // Build transcript JSON here (API concern). Add param version for auditability.
        // IMPORTANT: record the RNG label we actually used for sampling.
        let transcript_json = serde_json::json!({
            "math_param_version": KD_PARAM_VERSION,
            "die": die,
            "kappa": kappa,
            "face": face,
            "draw_u64": draw_u64.to_string(),
            "alpha": alpha,
            "kl": kl,
            "ev": ev,
            "probs": probs_vec,
            "sampling": { "method": "prefix_cdf", "rng": sampling_rng_label }
        });

        Ok(ComputeResult {
            face,
            draw_u64,
            ev,
            alpha,
            kl,
            transcript_json,
            param_version: KD_PARAM_VERSION,
        })
    })
}

/// Backward-compat: existing call sites can keep calling this variant. It will
/// mark `sampling.rng = "unknown"`. Prefer the `_labeled` variant above.
#[allow(dead_code)]
pub fn compute_roll_with_rng(
    die: &str,
    kappa: f64,
    rng: &mut impl RngCore,
    params_override: Option<Params>,
) -> anyhow::Result<ComputeResult> {
    compute_roll_with_rng_labeled(die, kappa, rng, params_override, "unknown")
}

/// Convenience wrapper used by older call sites. Keep it compiling but use rand 0.9 API.
#[allow(dead_code)]
pub fn compute_roll(die: &str, kappa: f64, _seed: Option<&str>) -> anyhow::Result<ComputeResult> {
    let mut rng = rand::rng(); // temporary fallback
    compute_roll_with_rng_labeled(die, kappa, &mut rng, None, "thread_rng")
}

/// Internal enum to hold Output<N> of any supported die. Lets us extract common scalars.
#[allow(clippy::large_enum_variant)]
enum OutAny {
    D6(Output<6>),
    D20(Output<20>),
    D100(Output<100>),
}

impl OutAny {
    fn into_parts(self) -> (f64, f64, f64, Vec<f64>) {
        match self {
            OutAny::D6(o) => (o.ev, o.alpha, o.kl, o.probs.into_iter().collect()),
            OutAny::D20(o) => (o.ev, o.alpha, o.kl, o.probs.into_iter().collect()),
            OutAny::D100(o) => (o.ev, o.alpha, o.kl, o.probs.into_iter().collect()),
        }
    }
}

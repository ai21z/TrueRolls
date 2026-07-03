use anyhow::{Context, Result, bail};
use clap::Args;
use kd_core::{
    die::Die,
    distribution::compute_distribution,
    params::{Params, default_for_die},
    sample::prefix_cdf_index_from_u64,
};
use rand::SeedableRng;
use rand_chacha::ChaCha20Rng;
use rand_core::RngCore;
use serde_json::json;
use std::path::PathBuf;

/// Version tag for local CLI transcripts. Bump on incompatible schema changes.
pub const TRANSCRIPT_VERSION: &str = "kd.local.v2";

/// Roll a die with guarded karma distribution.
///
/// By default, performs a local roll via kd-core (no server needed).
/// Remote roll is disabled until the CLI implements the drand-backed API flow.
#[derive(Args)]
#[command(allow_negative_numbers = true)]
pub struct RollArgs {
    /// Karma value in [-1.0, 1.0].
    #[arg(short, long, allow_hyphen_values = true)]
    kappa: f64,

    /// Die type: d4, d6, d8, d10, d12, d20, d100 (default: d20).
    #[arg(short, long, default_value = "d20")]
    die: String,

    /// Lambda (tilt strength). Overrides the per-die default if provided.
    #[arg(short, long)]
    lambda: Option<f64>,

    /// Deterministic seed (u64). If omitted, uses OS entropy.
    #[arg(short, long)]
    seed: Option<u64>,

    /// Number of rolls to perform.
    #[arg(short = 'c', long, default_value_t = 1)]
    count: usize,

    /// Write transcript JSON to this file (local mode only).
    #[arg(short, long)]
    output: Option<PathBuf>,

    /// Output as JSON to stdout.
    #[arg(long, default_value_t = false)]
    json: bool,

    /// Unsupported for drand-backed kd-api. Use the browser or API client flow.
    #[arg(long, default_value_t = false)]
    remote: bool,

    /// Base URL of the kd-api server (used with --remote).
    #[arg(long, default_value = "http://127.0.0.1:8080")]
    server: String,
}

pub fn execute(args: RollArgs) -> Result<()> {
    if args.kappa < -1.0 || args.kappa > 1.0 {
        bail!("κ must be in [-1.0, 1.0], got {}", args.kappa);
    }

    if args.remote {
        return execute_remote(&args);
    }

    let faces = parse_die(&args.die)?;
    let mut params = default_for_die(faces as usize);
    if let Some(l) = args.lambda {
        if !(0.0..=1.0).contains(&l) {
            bail!("λ must be in [0.0, 1.0], got {l}");
        }
        params.lambda = l;
    }

    let mut rng = match args.seed {
        Some(s) => ChaCha20Rng::seed_from_u64(s),
        None => ChaCha20Rng::from_rng(&mut rand::rng()),
    };

    let sampling_rng = if args.seed.is_some() {
        "ChaCha20Rng(seed_from_u64)"
    } else {
        "ChaCha20Rng(os_entropy)"
    };

    let mut results: Vec<serde_json::Value> = Vec::with_capacity(args.count);

    for _ in 0..args.count {
        let (face, draw, alpha, kl, ev, probs) =
            roll_dynamic(faces, args.kappa, &params, &mut rng)?;

        let mut entry = json!({
            "transcript_version": TRANSCRIPT_VERSION,
            "math_param_version": kd_core::PARAM_VERSION,
            "die": args.die,
            "kappa": args.kappa,
            "lambda": params.lambda,
            "face": face,
            "draw_u64": draw.to_string(),
            "alpha": alpha,
            "kl": kl,
            "ev": ev,
            "probs": probs,
            "sampling": { "method": "prefix_cdf", "rng": sampling_rng },
        });
        // Seed provenance: record only when a deterministic seed was supplied.
        // OS-entropy rolls intentionally omit the key.
        if let Some(s) = args.seed {
            entry["seed"] = json!(s.to_string());
        }

        if !args.json {
            println!("{face}");
        }

        results.push(entry);
    }

    if args.json {
        if results.len() == 1 {
            println!("{}", serde_json::to_string_pretty(&results[0])?);
        } else {
            println!("{}", serde_json::to_string_pretty(&results)?);
        }
    }

    if let Some(ref path) = args.output {
        let to_write = if results.len() == 1 {
            serde_json::to_string_pretty(&results[0])?
        } else {
            serde_json::to_string_pretty(&results)?
        };
        std::fs::write(path, &to_write)
            .with_context(|| format!("failed to write transcript to {}", path.display()))?;
        if !args.json {
            eprintln!("Transcript written to {}", path.display());
        }
    }

    Ok(())
}

fn execute_remote(args: &RollArgs) -> Result<()> {
    let _ = args;
    bail!("remote roll is not implemented for drand-backed API; use the browser/API client flow")
}

/// Parse "d20" → 20, "d6" → 6, etc.
fn parse_die(s: &str) -> Result<u32> {
    let s = s.trim().to_lowercase();
    let n: u32 = s
        .strip_prefix('d')
        .unwrap_or(&s)
        .parse()
        .with_context(|| format!("invalid die: {s}"))?;
    match n {
        4 | 6 | 8 | 10 | 12 | 20 | 100 => Ok(n),
        _ => bail!("unsupported die size: d{n}. Supported: d4, d6, d8, d10, d12, d20, d100"),
    }
}

/// Dynamic dispatch over supported die sizes to satisfy the const generic.
/// Returns (face, draw_u64, alpha, kl, ev, probs_vec).
///
/// Composes kd-core primitives directly (compute_distribution + one
/// `next_u64` + prefix_cdf_index_from_u64) so the raw draw can be recorded
/// in the transcript. This is byte-identical to what
/// `kd_core::sample::compute_roll` does internally (exactly one `next_u64`
/// per roll), so faces for existing seeds do not change.
fn roll_dynamic(
    faces: u32,
    kappa: f64,
    params: &Params,
    rng: &mut ChaCha20Rng,
) -> Result<(u32, u64, f64, f64, f64, Vec<f64>)> {
    macro_rules! do_roll {
        ($n:literal) => {{
            let out = compute_distribution::<$n>(Die::<$n>, kappa, params)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            let draw = rng.next_u64();
            let idx = prefix_cdf_index_from_u64::<$n>(&out.probs, draw);
            Ok((
                (idx + 1) as u32,
                draw,
                out.alpha,
                out.kl,
                out.ev,
                out.probs.to_vec(),
            ))
        }};
    }
    match faces {
        4 => do_roll!(4),
        6 => do_roll!(6),
        8 => do_roll!(8),
        10 => do_roll!(10),
        12 => do_roll!(12),
        20 => do_roll!(20),
        100 => do_roll!(100),
        _ => bail!("unsupported die: d{faces}"),
    }
}

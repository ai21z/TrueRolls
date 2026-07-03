use anyhow::{Context, Result, bail};
use clap::Args;
use kd_core::{
    die::Die,
    distribution::compute_distribution,
    math::{dkl_to_uniform, ev as compute_ev},
    params::{Params, default_for_die},
};
use kd_receipt::verify_receipt;
use rand_chacha::ChaCha20Rng;
use rand_core::{RngCore, SeedableRng};
use serde_json::json;
use std::path::PathBuf;

/// Verify distribution caps hold for given parameters, or verify a transcript/receipt file.
///
/// Three modes:
///   • Parameter mode (default): Check that caps hold for a given (die, κ, λ).
///   • Transcript mode (-i file.json): Re-derive the distribution from transcript
///     fields and compare face, alpha, kl, ev, probs. Prints verdict: OK or MISMATCH.
///   • Receipt mode (--receipt file.json): Verify a signed ReceiptV2 offline.
#[derive(Args)]
#[command(allow_negative_numbers = true)]
pub struct VerifyArgs {
    /// Karma value in [-1.0, 1.0] (parameter mode).
    #[arg(short, long, required_unless_present_any = ["input", "receipt"], allow_hyphen_values = true)]
    kappa: Option<f64>,

    /// Die type: d4, d6, d8, d10, d12, d20, d100 (default: d20).
    #[arg(short = 'd', long, default_value = "d20")]
    die: String,

    /// Lambda (tilt strength). Overrides per-die default if provided.
    #[arg(short, long)]
    lambda: Option<f64>,

    /// Number of κ steps for sweep mode. Sweeps from -1 to +1 inclusive.
    #[arg(long)]
    sweep: Option<usize>,

    /// Input transcript JSON file to verify (transcript mode).
    #[arg(short, long)]
    input: Option<PathBuf>,

    /// Signed receipt JSON file to verify offline (receipt mode).
    #[arg(long)]
    receipt: Option<PathBuf>,

    /// Ed25519 public key (base64) for offline receipt verification.
    /// If omitted, fetches from server's /.well-known/truerolls-keys.json
    #[arg(long)]
    public_key: Option<String>,

    /// POST transcript to a remote kd-api /v1/verify endpoint.
    #[arg(long, default_value_t = false)]
    remote: bool,

    /// Base URL of the kd-api server (used with --remote).
    #[arg(long, default_value = "http://127.0.0.1:8080")]
    server: String,

    /// Output as JSON.
    #[arg(long, default_value_t = false)]
    json: bool,

    /// Show the probability vector in JSON output.
    #[arg(long, default_value_t = false)]
    show_probs: bool,
}

pub fn execute(args: VerifyArgs) -> Result<()> {
    // Receipt mode: verify a signed receipt file offline
    if let Some(ref path) = args.receipt {
        return verify_receipt_offline(&args, path);
    }

    // Transcript mode: verify a transcript file
    if let Some(ref path) = args.input {
        return verify_transcript(&args, path);
    }

    // Parameter mode: verify caps hold
    verify_params(&args)
}

// ---------------------------------------------------------------------------
// Parameter mode, check caps hold across κ values
// ---------------------------------------------------------------------------

fn verify_params(args: &VerifyArgs) -> Result<()> {
    let faces = parse_die(&args.die)?;
    let mut params = default_for_die(faces as usize);
    if let Some(l) = args.lambda {
        if !(0.0..=1.0).contains(&l) {
            bail!("λ must be in [0.0, 1.0], got {l}");
        }
        params.lambda = l;
    }

    let kappa_val = args.kappa.unwrap_or(0.0);

    let kappas: Vec<f64> = if let Some(steps) = args.sweep {
        if steps == 0 {
            bail!("sweep must be at least 1");
        }
        (0..=steps)
            .map(|i| -1.0 + 2.0 * (i as f64) / (steps as f64))
            .collect()
    } else {
        if !(-1.0..=1.0).contains(&kappa_val) {
            bail!("κ must be in [-1.0, 1.0], got {kappa_val}");
        }
        vec![kappa_val]
    };

    let mut all_pass = true;
    let mut results: Vec<serde_json::Value> = Vec::new();

    for &kappa in &kappas {
        let verdict = verify_single_caps(faces, kappa, &params);
        let pass = verdict.is_ok();
        if !pass {
            all_pass = false;
        }

        if args.json {
            let mut entry = json!({
                "kappa": kappa,
                "die": format!("d{faces}"),
                "pass": pass,
            });
            if !pass {
                entry["reason"] = json!(verdict.unwrap_err());
            }
            if pass
                && args.show_probs
                && let Ok(probs) = get_probs(faces, kappa, &params)
            {
                entry["probs"] = json!(probs);
            }
            results.push(entry);
        } else if pass {
            println!("PASS  κ={kappa:+.4}  d{faces}");
        } else {
            println!("FAIL  κ={kappa:+.4}  d{faces}  - {}", verdict.unwrap_err());
        }
    }

    if args.json {
        if results.len() == 1 {
            println!("{}", serde_json::to_string_pretty(&results[0])?);
        } else {
            let summary = json!({
                "all_pass": all_pass,
                "count": results.len(),
                "results": results,
            });
            println!("{}", serde_json::to_string_pretty(&summary)?);
        }
    }

    if all_pass {
        Ok(())
    } else {
        bail!("one or more verifications FAILED")
    }
}

fn verify_single_caps(faces: u32, kappa: f64, params: &Params) -> std::result::Result<(), String> {
    macro_rules! check {
        ($n:literal) => {{ verify_typed::<$n>(kappa, params) }};
    }
    match faces {
        4 => check!(4),
        6 => check!(6),
        8 => check!(8),
        10 => check!(10),
        12 => check!(12),
        20 => check!(20),
        100 => check!(100),
        _ => Err(format!("unsupported die: d{faces}")),
    }
}

fn verify_typed<const N: usize>(kappa: f64, params: &Params) -> std::result::Result<(), String> {
    let out = compute_distribution::<N>(Die::<N>, kappa, params)
        .map_err(|e| format!("compute_distribution: {e}"))?;

    let tol = 1e-12;
    let sum: f64 = out.probs.iter().sum();
    if (sum - 1.0).abs() >= tol {
        return Err("probs do not sum to 1".into());
    }
    if out.probs.iter().any(|&p| p < 0.0) {
        return Err("negative probability".into());
    }
    if out.kl > params.kl_cap_nats + tol {
        return Err(format!(
            "KL cap exceeded: {:.6} > {:.6}",
            out.kl, params.kl_cap_nats
        ));
    }

    let mu = Die::<N>::ev_uniform();
    let sd = Die::<N>::sd_uniform();
    if (out.ev - mu).abs() > params.ev_cap_sd * sd + tol {
        return Err(format!(
            "EV cap exceeded: |{:.6} - {:.6}| > {:.6}",
            out.ev,
            mu,
            params.ev_cap_sd * sd
        ));
    }
    if out.alpha < 0.0 || out.alpha > 1.0 {
        return Err(format!("alpha outside [0, 1]: {}", out.alpha));
    }

    // Cross-check: recompute KL and EV from probs independently
    let kl_check = dkl_to_uniform::<N>(&out.probs);
    let ev_check = compute_ev::<N>(&out.probs);
    if (kl_check - out.kl).abs() >= tol {
        return Err("KL self-consistency check failed".into());
    }
    if (ev_check - out.ev).abs() >= tol {
        return Err("EV self-consistency check failed".into());
    }

    Ok(())
}

fn get_probs(faces: u32, kappa: f64, params: &Params) -> Result<Vec<f64>> {
    macro_rules! probs_for {
        ($n:literal) => {{
            let out = compute_distribution::<$n>(Die::<$n>, kappa, params)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            Ok(out.probs.to_vec())
        }};
    }
    match faces {
        4 => probs_for!(4),
        6 => probs_for!(6),
        8 => probs_for!(8),
        10 => probs_for!(10),
        12 => probs_for!(12),
        20 => probs_for!(20),
        100 => probs_for!(100),
        _ => bail!("unsupported die: d{faces}"),
    }
}

// ---------------------------------------------------------------------------
// Transcript mode, verify a transcript JSON file
// ---------------------------------------------------------------------------

fn verify_transcript(args: &VerifyArgs, path: &PathBuf) -> Result<()> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let transcript: serde_json::Value =
        serde_json::from_str(&content).context("invalid JSON in transcript file")?;

    if args.remote {
        return verify_transcript_remote(args, &transcript);
    }

    verify_transcript_local(args, &transcript)
}

/// Result of verifying a single transcript entry against recomputation.
struct EntryReport {
    die: String,
    kappa: f64,
    mismatches: Vec<String>,
    warnings: Vec<String>,
    recomputed_alpha: f64,
    recomputed_kl: f64,
    recomputed_ev: f64,
}

impl EntryReport {
    fn pass(&self) -> bool {
        self.mismatches.is_empty()
    }

    fn verdict(&self) -> &'static str {
        if self.pass() { "OK" } else { "MISMATCH" }
    }

    fn to_json(&self) -> serde_json::Value {
        let mut result = json!({
            "verdict": self.verdict(),
            "die": self.die,
            "kappa": self.kappa,
        });
        if !self.mismatches.is_empty() {
            result["mismatches"] = json!(self.mismatches);
        }
        if !self.warnings.is_empty() {
            result["warnings"] = json!(self.warnings);
        }
        result["recomputed"] = json!({
            "alpha": self.recomputed_alpha,
            "kl": self.recomputed_kl,
            "ev": self.recomputed_ev,
        });
        result
    }
}

fn verify_transcript_local(args: &VerifyArgs, transcript: &serde_json::Value) -> Result<()> {
    // `kd roll -c N --output` writes a JSON array of entries, verify each
    // entry independently and aggregate the verdict.
    if let Some(entries) = transcript.as_array() {
        return verify_transcript_local_array(args, entries);
    }

    let report = verify_transcript_entry_with_seed_index(transcript, 0)?;
    let pass = report.pass();

    if args.json {
        println!("{}", serde_json::to_string_pretty(&report.to_json())?);
    } else if pass {
        println!("verdict: OK");
        for w in &report.warnings {
            println!("  warning: {w}");
        }
    } else {
        println!("verdict: MISMATCH");
        for m in &report.mismatches {
            println!("  {m}");
        }
    }

    if pass {
        Ok(())
    } else {
        bail!("transcript verification FAILED")
    }
}

fn verify_transcript_local_array(args: &VerifyArgs, entries: &[serde_json::Value]) -> Result<()> {
    if entries.is_empty() {
        bail!("transcript array is empty - nothing to verify");
    }

    let mut reports: Vec<EntryReport> = Vec::with_capacity(entries.len());
    for (i, entry) in entries.iter().enumerate() {
        let report = verify_transcript_entry_with_seed_index(entry, i)
            .with_context(|| format!("entry[{i}]"))?;
        reports.push(report);
    }

    let all_pass = reports.iter().all(EntryReport::pass);
    let verdict = if all_pass { "OK" } else { "MISMATCH" };

    if args.json {
        let result = json!({
            "verdict": verdict,
            "count": reports.len(),
            "entries": reports.iter().map(EntryReport::to_json).collect::<Vec<_>>(),
        });
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        for (i, report) in reports.iter().enumerate() {
            println!("entry[{i}]: {}", report.verdict());
            for w in &report.warnings {
                println!("entry[{i}]:   warning: {w}");
            }
            for m in &report.mismatches {
                println!("entry[{i}]:   {m}");
            }
        }
        println!("verdict: {verdict}");
    }

    if all_pass {
        Ok(())
    } else {
        bail!("transcript verification FAILED")
    }
}

fn verify_transcript_entry_with_seed_index(
    transcript: &serde_json::Value,
    seed_draw_index: usize,
) -> Result<EntryReport> {
    // Version gate 1: if a transcript_version is declared, it must be one we
    // understand. (Server transcripts do not carry this key, that is fine.)
    if let Some(tv) = transcript.get("transcript_version") {
        let tv_str = tv.as_str().unwrap_or("");
        if tv_str != crate::commands::roll::TRANSCRIPT_VERSION {
            bail!(
                "unsupported transcript_version '{}' - expected '{}'",
                tv_str,
                crate::commands::roll::TRANSCRIPT_VERSION
            );
        }
    }

    // Version gate 2: math param version is mandatory. Accept the canonical
    // `math_param_version` (server + kd.local.v2) with fallback to the legacy
    // `param_version` key (kd.local v1 transcripts).
    let math_param_version = transcript
        .get("math_param_version")
        .and_then(|v| v.as_str())
        .or_else(|| transcript.get("param_version").and_then(|v| v.as_str()));
    let Some(pv) = math_param_version else {
        bail!("transcript missing math_param_version");
    };
    if pv != kd_core::PARAM_VERSION {
        bail!(
            "transcript param_version '{}' != current '{}' - cannot verify",
            pv,
            kd_core::PARAM_VERSION
        );
    }

    // Extract fields from transcript
    let die_str = transcript
        .get("die")
        .and_then(|v| v.as_str())
        .context("transcript missing 'die' field")?;
    let faces = parse_die(die_str)?;

    let kappa = transcript
        .get("kappa")
        .and_then(|v| v.as_f64())
        .context("transcript missing 'kappa' field")?;

    let (lambda, invalid_lambda) = match transcript.get("lambda") {
        Some(v) => {
            let l = v.as_f64().context("transcript 'lambda' is not a number")?;
            if !(0.0..=1.0).contains(&l) {
                (None, Some(l))
            } else {
                (Some(l), None)
            }
        }
        None => (None, None),
    };

    let claimed_alpha = transcript.get("alpha").and_then(|v| v.as_f64());
    let claimed_kl = transcript.get("kl").and_then(|v| v.as_f64());
    let claimed_ev = transcript.get("ev").and_then(|v| v.as_f64());

    let claimed_probs: Option<Vec<f64>> = transcript.get("probs").and_then(|v| {
        v.as_array()
            .map(|arr| arr.iter().filter_map(|x| x.as_f64()).collect())
    });

    // Recompute from (die, κ, λ)
    let mut params = default_for_die(faces as usize);
    if let Some(l) = lambda {
        params.lambda = l;
    }

    let (recomp_alpha, recomp_kl, recomp_ev, recomp_probs) =
        recompute_distribution(faces, kappa, &params)?;

    let tol = 1e-9; // tolerance for float comparison after JSON round-trip
    let mut mismatches: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    if let Some(l) = invalid_lambda {
        mismatches.push(format!("lambda {l} out of range [0, 1]"));
    }

    // Compare alpha
    if let Some(ca) = claimed_alpha {
        let diff = (ca - recomp_alpha).abs();
        if diff > tol {
            mismatches.push(format!(
                "alpha: claimed={ca}, recomputed={recomp_alpha}, diff={diff:.2e}"
            ));
        }
    }

    // Compare KL
    if let Some(ck) = claimed_kl {
        let diff = (ck - recomp_kl).abs();
        if diff > tol {
            mismatches.push(format!(
                "kl: claimed={ck}, recomputed={recomp_kl}, diff={diff:.2e}"
            ));
        }
    }

    // Compare EV
    if let Some(ce) = claimed_ev {
        let diff = (ce - recomp_ev).abs();
        if diff > tol {
            mismatches.push(format!(
                "ev: claimed={ce}, recomputed={recomp_ev}, diff={diff:.2e}"
            ));
        }
    }

    // Compare probs
    if let Some(ref cp) = claimed_probs {
        if cp.len() != recomp_probs.len() {
            mismatches.push(format!(
                "probs length: claimed={}, recomputed={}",
                cp.len(),
                recomp_probs.len()
            ));
        } else {
            for (i, (c, r)) in cp.iter().zip(recomp_probs.iter()).enumerate() {
                let diff = (c - r).abs();
                if diff > tol {
                    mismatches.push(format!("probs[{i}]: diff={diff:.2e}"));
                } else if diff > 1e-15 {
                    warnings.push(format!(
                        "probs[{i}]: minor float round-trip diff={diff:.2e}"
                    ));
                }
            }
        }
    }

    // Face policy: a face claim is only verifiable when draw_u64 is present
    // and replayable. A face without a valid draw is a MISMATCH, not a
    // silent pass, otherwise tampered faces would verify as OK.
    let draw: Option<u64> = transcript
        .get("draw_u64")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<u64>().ok());

    if let Some(seed_value) = transcript.get("seed") {
        let sampling_rng = transcript
            .get("sampling")
            .and_then(|v| v.get("rng"))
            .and_then(|v| v.as_str());
        if sampling_rng == Some("ChaCha20Rng(seed_from_u64)") {
            match (seed_value.as_str(), draw) {
                (Some(seed_str), Some(draw_u64)) => match seed_str.parse::<u64>() {
                    Ok(seed) => {
                        let mut rng = ChaCha20Rng::seed_from_u64(seed);
                        let mut replayed = 0;
                        for _ in 0..=seed_draw_index {
                            replayed = rng.next_u64();
                        }
                        if replayed != draw_u64 {
                            mismatches.push(format!(
                                "seed/draw mismatch: seed replays {replayed}, transcript draw_u64={draw_u64}"
                            ));
                        }
                    }
                    Err(_) => mismatches.push("seed is not a valid u64".to_string()),
                },
                (None, _) => mismatches.push("seed is not a stringified u64".to_string()),
                (_, None) => {}
            }
        }
    }

    match transcript.get("face").and_then(|v| v.as_u64()) {
        None => {
            mismatches.push("face: missing from transcript".to_string());
        }
        Some(cf) => {
            if cf < 1 || cf > u64::from(faces) {
                mismatches.push(format!("face {cf} out of range for d{faces}"));
            }
            match draw {
                None => {
                    mismatches.push(
                        "face: unverifiable - draw_u64 missing/invalid; cannot replay sampling"
                            .to_string(),
                    );
                }
                Some(draw_u64) => {
                    let recomp_face = replay_face(faces, &recomp_probs, draw_u64)?;
                    if cf != u64::from(recomp_face) {
                        mismatches.push(format!(
                            "face: claimed={cf}, recomputed={recomp_face} (from draw_u64)"
                        ));
                    }
                }
            }
        }
    }

    Ok(EntryReport {
        die: format!("d{faces}"),
        kappa,
        mismatches,
        warnings,
        recomputed_alpha: recomp_alpha,
        recomputed_kl: recomp_kl,
        recomputed_ev: recomp_ev,
    })
}

/// Map a local transcript entry to the flat `VerifyRequest` body that the
/// server's `POST /v1/verify` expects (kd-api `models/dto.rs`).
///
/// The server branches on `"v": "truerolls-1"` for receipts and otherwise
/// deserializes the body as a flat `VerifyRequest`, a wrapped
/// `{"transcript": ...}` envelope always 400s (F-02).
///
/// Refusal policy: the server recomputes with FIXED default params (λ=0.5)
/// and supports only d6/d20/d100. A transcript the server cannot faithfully
/// verify is refused here with a clear message instead of being sent, an
/// honest refusal beats a false MISMATCH.
fn remote_verify_body(transcript: &serde_json::Value) -> Result<serde_json::Value> {
    if transcript.is_array() {
        bail!("remote verify accepts single-roll transcripts; arrays are local-only");
    }

    // die: server contract supports only d6/d20/d100.
    let die = transcript
        .get("die")
        .and_then(|v| v.as_str())
        .context("transcript missing 'die' field")?;
    if !matches!(die, "d6" | "d20" | "d100") {
        bail!("remote verify supports only d6/d20/d100 (server contract); use local verify");
    }

    // λ: the server recomputes with the fixed per-die default λ=0.5. A
    // transcript rolled with a different λ would recompute differently
    // server-side and falsely MISMATCH. Refuse instead.
    if let Some(lv) = transcript.get("lambda") {
        let lambda = lv.as_f64().context("transcript 'lambda' is not a number")?;
        if (lambda - 0.5).abs() > 1e-12 {
            bail!(
                "server verifies with fixed default λ=0.5; this transcript uses λ={lambda} - remote verification would falsely MISMATCH; use local verify"
            );
        }
    }

    // draw_u64: mandatory, stringified u64, without it the server cannot
    // replay the face.
    let draw_str = match transcript.get("draw_u64") {
        None => bail!("transcript missing 'draw_u64' - the server cannot replay the face"),
        Some(v) => v
            .as_str()
            .context("transcript 'draw_u64' must be a stringified u64")?,
    };
    draw_str
        .parse::<u64>()
        .with_context(|| format!("transcript 'draw_u64' value '{draw_str}' is not a valid u64"))?;

    let face = transcript
        .get("face")
        .and_then(|v| v.as_u64())
        .context("transcript missing 'face' field")?;

    let kappa = transcript
        .get("kappa")
        .and_then(|v| v.as_f64())
        .context("transcript missing 'kappa' field")?;
    let alpha = transcript
        .get("alpha")
        .and_then(|v| v.as_f64())
        .context("transcript missing 'alpha' field")?;
    let kl = transcript
        .get("kl")
        .and_then(|v| v.as_f64())
        .context("transcript missing 'kl' field")?;
    let ev = transcript
        .get("ev")
        .and_then(|v| v.as_f64())
        .context("transcript missing 'ev' field")?;

    let probs = transcript
        .get("probs")
        .and_then(|v| v.as_array())
        .context("transcript missing 'probs' field")?;
    if !probs.iter().all(|x| x.is_number()) {
        bail!("transcript 'probs' must be an array of numbers");
    }

    // Canonical `math_param_version` (server + kd.local.v2 key name) with
    // fallback to the legacy `param_version` (kd.local v1 transcripts).
    let math_param_version = transcript
        .get("math_param_version")
        .and_then(|v| v.as_str())
        .or_else(|| transcript.get("param_version").and_then(|v| v.as_str()))
        .context("transcript missing math_param_version")?;

    // Exactly the 9 VerifyRequest fields. Local-only keys (transcript_version,
    // lambda, seed, sampling, rng, ...) are dropped.
    Ok(json!({
        "math_param_version": math_param_version,
        "die": die,
        "kappa": kappa,
        "face": face,
        "draw_u64": draw_str,
        "alpha": alpha,
        "kl": kl,
        "ev": ev,
        "probs": probs,
    }))
}

fn verify_transcript_remote(args: &VerifyArgs, transcript: &serde_json::Value) -> Result<()> {
    // Refusals (unsupported die, non-default λ, arrays, missing fields) exit
    // non-zero with a clear message before anything is sent.
    let body = remote_verify_body(transcript)?;

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    let resp = client
        .post(format!("{}/v1/verify", args.server))
        .json(&body)
        .send()
        .context("failed to reach kd-api server")?;

    let status = resp.status();
    let text = resp.text()?;

    match status.as_u16() {
        // OK, body is the VerifyResponse JSON.
        200 => {
            let v: serde_json::Value =
                serde_json::from_str(&text).context("server returned 200 with non-JSON body")?;
            if args.json {
                println!("{}", serde_json::to_string_pretty(&v)?);
            } else {
                let verdict = v.get("verdict").and_then(|x| x.as_str()).unwrap_or("OK");
                println!("verdict: {verdict}");
                if let Some(warnings) = v.get("warnings").and_then(|w| w.as_array()) {
                    for w in warnings.iter().filter_map(|w| w.as_str()) {
                        println!("  warning: {w}");
                    }
                }
            }
            Ok(())
        }
        // MISMATCH, the 422 body is the VerifyResponse JSON serialized as a
        // plain-text string (kd-api routes/verify.rs `run_verification`).
        422 => {
            let v: serde_json::Value = serde_json::from_str(&text)
                .with_context(|| format!("server returned 422 with unparseable body: {text}"))?;
            if args.json {
                println!("{}", serde_json::to_string_pretty(&v)?);
            } else {
                let verdict = v
                    .get("verdict")
                    .and_then(|x| x.as_str())
                    .unwrap_or("MISMATCH");
                println!("verdict: {verdict}");
                if let Some(mismatches) = v.get("mismatches").and_then(|m| m.as_array()) {
                    for m in mismatches.iter().filter_map(|m| m.as_str()) {
                        println!("  {m}");
                    }
                }
            }
            bail!("remote transcript verification FAILED (server verdict: MISMATCH)")
        }
        // Contract rejection, surface the server's error text verbatim.
        400 => bail!("server rejected request (400): {text}"),
        _ => bail!("server returned {status}: {text}"),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

fn recompute_distribution(
    faces: u32,
    kappa: f64,
    params: &Params,
) -> Result<(f64, f64, f64, Vec<f64>)> {
    macro_rules! compute {
        ($n:literal) => {{
            let out = compute_distribution::<$n>(Die::<$n>, kappa, params)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            Ok((out.alpha, out.kl, out.ev, out.probs.to_vec()))
        }};
    }
    match faces {
        4 => compute!(4),
        6 => compute!(6),
        8 => compute!(8),
        10 => compute!(10),
        12 => compute!(12),
        20 => compute!(20),
        100 => compute!(100),
        _ => bail!("unsupported die: d{faces}"),
    }
}

fn replay_face(faces: u32, probs: &[f64], draw_u64: u64) -> Result<u32> {
    // Replay prefix_cdf_index_from_u64 logic
    let u = (draw_u64 as f64) / ((u64::MAX as f64) + 1.0);
    let mut acc = 0.0;
    for (i, &p) in probs.iter().enumerate() {
        acc += p;
        if u < acc {
            return Ok((i + 1) as u32);
        }
    }
    Ok(faces) // last face
}

// ---------------------------------------------------------------------------
// Receipt mode, verify a signed ReceiptV2 offline
// ---------------------------------------------------------------------------

fn verify_receipt_offline(args: &VerifyArgs, path: &PathBuf) -> Result<()> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read {}", path.display()))?;

    let receipt_value: serde_json::Value =
        serde_json::from_str(&content).context("invalid JSON in receipt file")?;

    // The public key is only needed for a signed receipt. Use --public-key if
    // given, else fetch from the server's well-known endpoint keyed by the
    // receipt's own kid.
    let public_key_b64 = match &args.public_key {
        Some(pk) => pk.clone(),
        None => {
            let kid = receipt_value
                .get("sig")
                .and_then(|s| s.get("kid"))
                .and_then(|k| k.as_str());
            match kid {
                Some(kid) => {
                    eprintln!("Fetching public key from {}", args.server);
                    fetch_public_key(&args.server, kid)?
                }
                None => String::new(), // unsigned receipt, key unused
            }
        }
    };

    // Single shared verifier, the exact same engine the browser runs through
    // kd-core-wasm. Hard (unverifiable) failures map back to a CLI error/exit 1.
    let report =
        verify_receipt(&receipt_value, &public_key_b64).map_err(|e| anyhow::anyhow!("{e}"))?;
    let all_ok = report.is_valid();

    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report.to_result_json())?
        );
    } else if all_ok {
        println!("✅ VALID");
        println!("  signature: OK");
        println!("  sampling:  OK (draw_u64 replayed correctly)");
        println!("  face:      OK ({})", report.recomputed_face);
        println!(
            "  metrics:   OK (α={:.6}, KL={:.6}, EV={:.4})",
            report.recomputed_alpha, report.recomputed_kl, report.recomputed_ev
        );
    } else {
        println!("❌ INVALID");
        for e in &report.errors {
            println!("  • {e}");
        }
    }

    if all_ok {
        Ok(())
    } else {
        bail!("receipt verification FAILED")
    }
}

/// Fetch the Ed25519 public key (base64) for a given kid from the server.
fn fetch_public_key(server: &str, kid: &str) -> Result<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    let resp = client
        .get(format!("{server}/.well-known/truerolls-keys.json"))
        .send()
        .context("failed to reach server for public key")?;

    if !resp.status().is_success() {
        bail!("server returned {} for public key request", resp.status());
    }

    let body: serde_json::Value = resp.json()?;
    let keys = body
        .get("keys")
        .and_then(|k| k.as_array())
        .context("no 'keys' array in response")?;

    for key in keys {
        if key.get("kid").and_then(|k| k.as_str()) == Some(kid) {
            let pk = key
                .get("public_key")
                .and_then(|k| k.as_str())
                .context("key entry missing 'public_key'")?;
            return Ok(pk.to_string());
        }
    }

    bail!("no key found with kid='{kid}'")
}

// ---------------------------------------------------------------------------
// Tests, remote_verify_body (no server required)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod remote_tests {
    use super::remote_verify_body;
    use serde_json::json;

    /// A kd.local.v2-shaped transcript entry (as written by `kd roll --output`).
    fn local_v2_entry() -> serde_json::Value {
        json!({
            "transcript_version": "kd.local.v2",
            "math_param_version": "roll.math.v1",
            "die": "d6",
            "kappa": 0.6,
            "lambda": 0.5,
            "face": 4,
            "draw_u64": "9482535800248027256",
            "seed": "42",
            "alpha": 0.25,
            "kl": 0.0098,
            "ev": 3.71,
            "probs": [0.12, 0.14, 0.16, 0.18, 0.19, 0.21],
            "sampling": { "method": "prefix_cdf", "rng": "ChaCha20Rng(seed_from_u64)" }
        })
    }

    #[test]
    fn maps_fields_and_strips_local_only_keys() {
        let body = remote_verify_body(&local_v2_entry()).expect("should build body");
        let obj = body.as_object().expect("body must be a JSON object");

        // Exactly the 9 VerifyRequest keys, nothing else.
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "alpha",
                "die",
                "draw_u64",
                "ev",
                "face",
                "kappa",
                "kl",
                "math_param_version",
                "probs",
            ]
        );

        assert_eq!(body["math_param_version"], "roll.math.v1");
        assert_eq!(body["die"], "d6");
        assert_eq!(body["kappa"], 0.6);
        assert_eq!(body["face"], 4);
        assert_eq!(body["draw_u64"], "9482535800248027256");
        assert_eq!(body["alpha"], 0.25);
        assert_eq!(body["kl"], 0.0098);
        assert_eq!(body["ev"], 3.71);
        assert_eq!(body["probs"].as_array().map(Vec::len), Some(6));

        // Local-only keys must be gone.
        for stripped in ["transcript_version", "lambda", "seed", "sampling"] {
            assert!(obj.get(stripped).is_none(), "'{stripped}' must be stripped");
        }
    }

    #[test]
    fn accepts_legacy_param_version_fallback() {
        let mut t = local_v2_entry();
        let obj = t.as_object_mut().unwrap();
        obj.remove("math_param_version");
        obj.insert("param_version".into(), json!("roll.math.v1"));

        let body = remote_verify_body(&t).expect("legacy param_version must be accepted");
        assert_eq!(body["math_param_version"], "roll.math.v1");
        assert!(body.get("param_version").is_none());
    }

    #[test]
    fn refuses_missing_both_param_versions() {
        let mut t = local_v2_entry();
        t.as_object_mut().unwrap().remove("math_param_version");

        let err = remote_verify_body(&t).unwrap_err().to_string();
        assert!(
            err.contains("math_param_version"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn refuses_non_default_lambda() {
        let mut t = local_v2_entry();
        t["lambda"] = json!(0.6);

        let err = remote_verify_body(&t).unwrap_err().to_string();
        assert!(
            err.contains("fixed default λ=0.5"),
            "unexpected error: {err}"
        );
        assert!(err.contains("λ=0.6"), "unexpected error: {err}");
        assert!(err.contains("use local verify"), "unexpected error: {err}");
    }

    #[test]
    fn accepts_default_lambda_within_tolerance() {
        let mut t = local_v2_entry();
        t["lambda"] = json!(0.5);
        assert!(remote_verify_body(&t).is_ok());

        // Missing lambda (server-shape transcript) is fine too.
        t.as_object_mut().unwrap().remove("lambda");
        assert!(remote_verify_body(&t).is_ok());
    }

    #[test]
    fn refuses_unsupported_die() {
        let mut t = local_v2_entry();
        t["die"] = json!("d12");

        let err = remote_verify_body(&t).unwrap_err().to_string();
        assert!(err.contains("only d6/d20/d100"), "unexpected error: {err}");
        assert!(err.contains("use local verify"), "unexpected error: {err}");
    }

    #[test]
    fn refuses_missing_draw_u64() {
        let mut t = local_v2_entry();
        t.as_object_mut().unwrap().remove("draw_u64");

        let err = remote_verify_body(&t).unwrap_err().to_string();
        assert!(err.contains("draw_u64"), "unexpected error: {err}");
    }

    #[test]
    fn refuses_non_string_draw_u64() {
        let mut t = local_v2_entry();
        t["draw_u64"] = json!(9482535800248027256u64);

        let err = remote_verify_body(&t).unwrap_err().to_string();
        assert!(err.contains("stringified u64"), "unexpected error: {err}");
    }

    #[test]
    fn refuses_unparseable_draw_u64() {
        let mut t = local_v2_entry();
        t["draw_u64"] = json!("not-a-number");

        let err = remote_verify_body(&t).unwrap_err().to_string();
        assert!(err.contains("not a valid u64"), "unexpected error: {err}");
    }

    #[test]
    fn refuses_array_input() {
        let t = json!([local_v2_entry(), local_v2_entry()]);

        let err = remote_verify_body(&t).unwrap_err().to_string();
        assert!(
            err.contains("arrays are local-only"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn refuses_missing_face() {
        let mut t = local_v2_entry();
        t.as_object_mut().unwrap().remove("face");

        let err = remote_verify_body(&t).unwrap_err().to_string();
        assert!(err.contains("face"), "unexpected error: {err}");
    }

    #[test]
    fn refuses_missing_math_fields() {
        for field in ["kappa", "alpha", "kl", "ev", "probs"] {
            let mut t = local_v2_entry();
            t.as_object_mut().unwrap().remove(field);

            let err = remote_verify_body(&t).unwrap_err().to_string();
            assert!(
                err.contains(field),
                "missing '{field}': unexpected error: {err}"
            );
        }
    }
}

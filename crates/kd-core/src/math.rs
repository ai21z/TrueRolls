//! Numerically-stable softmax and related utilities per v1.3.1.

pub fn logsumexp<const N: usize>(xs: &[f64; N]) -> f64 {
    let mut m = xs[0];
    for &x in xs.iter().skip(1) {
        if x > m {
            m = x;
        }
    }
    let mut s = 0.0;
    for &x in xs.iter() {
        s += (x - m).exp();
    }
    m + s.ln()
}

pub fn softmax_stable<const N: usize>(logits: &[f64; N]) -> [f64; N] {
    let lse = logsumexp(logits);
    let mut p = [0.0; N];
    let mut i = 0;
    while i < N {
        p[i] = (logits[i] - lse).exp();
        i += 1;
    }
    p
}

/// Apply ε floor then renormalize (sum≈1).
pub fn floor_and_renorm_eps<const N: usize>(mut p: [f64; N], eps: f64) -> [f64; N] {
    let mut s = 0.0;
    for v in p.iter_mut() {
        if *v < eps {
            *v = eps;
        }
        s += *v;
    }
    let inv = 1.0 / s;
    for v in p.iter_mut() {
        *v *= inv;
    }
    p
}

/// Expected value over faces 1..=N
pub fn ev<const N: usize>(p: &[f64; N]) -> f64 {
    let mut s = 0.0;
    for (i, &pi) in p.iter().enumerate() {
        s += (i as f64 + 1.0) * pi;
    }
    s
}

/// KL divergence D_KL(p || u), u = uniform on N.
pub fn dkl_to_uniform<const N: usize>(p: &[f64; N]) -> f64 {
    let n = N as f64;
    let ln_n = n.ln();
    let mut s = 0.0;
    for &pi in p.iter() {
        if pi > 0.0 {
            s += pi * (pi.ln() + ln_n); // pi * ln(pi / (1/N))
        }
    }
    s
}

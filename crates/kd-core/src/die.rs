//! Die helpers, generic over N (faces 1..=N).
//! Face scores are standardized to mean 0 and variance 1 under the uniform.
//! μ_u = (N+1)/2; σ_u^2 = (N^2 - 1)/12.

pub struct Die<const N: usize>;

impl<const N: usize> Die<N> {
    #[inline]
    pub const fn n() -> usize {
        N
    }

    #[inline]
    pub fn ev_uniform() -> f64 {
        (N as f64 + 1.0) / 2.0
    }

    #[inline]
    pub fn sd_uniform() -> f64 {
        let n = N as f64;
        ((n * n - 1.0) / 12.0).sqrt()
    }

    /// Standardized scores g(i) with mean 0 and Var 1.
    pub fn face_scores_unitvar() -> [f64; N] {
        assert!(N >= 2, "die size must be >= 2");
        let mut out = [0.0; N];
        let mu = Self::ev_uniform();
        let sd = Self::sd_uniform();
        let mut i = 0;
        while i < N {
            out[i] = (i as f64 + 1.0 - mu) / sd;
            i += 1;
        }
        out
    }
}

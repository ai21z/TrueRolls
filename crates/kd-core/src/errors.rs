use thiserror::Error;

/// All kd-core errors bubble up as std::error::Error so callers (kd-api)
/// can use `?` into `anyhow::Error` without adapters.
#[derive(Debug, Clone, Error)]
pub enum CoreError {
    #[error("invalid die size: {0}")]
    InvalidDieSize(usize),

    #[error("non-finite input")]
    NonFiniteInput,

    #[error("kappa out of range: {0} (must be in [-1, 1])")]
    KappaOutOfRange(f64),

    #[error("α search failed to converge")]
    SearchFailed,
}

// impl core::fmt::Display for CoreError {
//     fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
//         match self {
//             Self::InvalidDieSize(n) => write!(f, "invalid die size: {}", n),
//             Self::NonFiniteInput => write!(f, "non-finite input"),
//             Self::SearchFailed => write!(f, "α search failed to converge"),
//         }
//     }
// }

// #[cfg(feature = "std")]
// impl std::error::Error for CoreError {}

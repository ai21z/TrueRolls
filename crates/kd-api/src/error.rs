// AppError -> IntoResponse + helpers

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use thiserror::Error;

#[allow(dead_code)]
pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Internal(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    UnprocessableEntity(String),
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, msg).into_response(),
            AppError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response(),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg).into_response(),
            AppError::UnprocessableEntity(msg) => {
                (StatusCode::UNPROCESSABLE_ENTITY, msg).into_response()
            }
        }
    }
}

// Shorthand constructors
pub fn bad_request<T: ToString>(msg: T) -> AppError {
    AppError::BadRequest(msg.to_string())
}
pub fn conflict<T: ToString>(msg: T) -> AppError {
    AppError::Conflict(msg.to_string())
}
pub fn internal<T: ToString>(msg: T) -> AppError {
    AppError::Internal(msg.to_string())
}
pub fn not_found<T: ToString>(msg: T) -> AppError {
    AppError::NotFound(msg.to_string())
}
pub fn unprocessable<T: ToString>(msg: T) -> AppError {
    AppError::UnprocessableEntity(msg.to_string())
}

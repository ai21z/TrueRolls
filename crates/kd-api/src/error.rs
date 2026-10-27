// AppError -> IntoResponse + helpers

use axum::{
    Json,
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
            AppError::Internal(msg) => {
                tracing::error!(event = "app.internal_error", error = %msg);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "internal" })),
                )
                    .into_response()
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn internal_response_hides_detail() {
        let response =
            AppError::Internal("secret redis://topology detail".to_string()).into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let text = String::from_utf8(body.to_vec()).expect("utf8 body");
        assert!(text.contains("internal"));
        assert!(!text.contains("secret"));
        assert!(!text.contains("redis"));
    }
}

# syntax=docker/dockerfile:1
# TrueRolls kd-api - multi-stage Linux image.
#
# Build from the WORKSPACE ROOT (context = repo root): kd-api depends on the `kd-core`
# path crate and the workspace `Cargo.lock`, so the whole workspace must be present.
#     docker build -t kd-api .
#
# DB-free: SQLX_OFFLINE=true uses the committed `.sqlx/` query cache, so the build needs no
# Postgres. Cargo.lock and the Rust image version constrain dependencies and toolchain, but
# byte-for-byte image reproducibility also requires digest-pinned base images and controlled
# build inputs. aws-lc-sys (pulled via rustls / aws-lc-rs) needs cmake + a C toolchain + perl
# on Linux - NOT NASM (NASM is only required on Windows).
#
# Note: this is a correct, simple build. A future optimization (cargo-chef or a
# Cargo.toml-first dependency layer) would cache dependency compilation across source
# changes; omitted here to keep the Dockerfile obvious.

# ---- builder ----------------------------------------------------------------
FROM rust:1.93.1-bookworm@sha256:7c4ae649a84014c467d79319bbf17ce2632ae8b8be123ac2fb2ea5be46823f31 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
        cmake build-essential perl pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Offline, DB-free build using the committed .sqlx cache.
ENV SQLX_OFFLINE=true
RUN cargo build --locked --release -p kd-api

# ---- runtime ----------------------------------------------------------------
FROM debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df AS runtime

# TLS roots for the AWS S3 SDK (Tigris / MinIO over HTTPS).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Non-root runtime user.
RUN useradd --system --uid 10001 --no-create-home kd

COPY --from=builder /app/target/release/kd-api /usr/local/bin/kd-api

USER kd

# DB migrations are embedded in the binary at compile time via `sqlx::migrate!()`, so the
# runtime image needs nothing else. Configure everything else (DATABASE_URL, REDIS_URL,
# S3_*, KD_SIGNING_*, KD_ENV) via runtime env / secrets.
ENV API_HOST=0.0.0.0 \
    API_PORT=8080
EXPOSE 8080

# Liveness only: /livez does no dependency I/O, so this probe cannot load Postgres, Redis or S3.
# Dependency readiness stays on /healthz for operators and deployment smoke checks.
HEALTHCHECK --interval=3s --timeout=2s --start-period=5s --retries=20 \
    CMD curl -fsS http://127.0.0.1:8080/livez | grep -q '"status":"ok"' || exit 1

ENTRYPOINT ["kd-api"]

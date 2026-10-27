# syntax=docker/dockerfile:1
# Non-production S3 fixture. Upstream no longer publishes the legacy container.
FROM golang:1.24.6-bookworm@sha256:ab1d1823abb55a9504d2e3e003b75b36dbeb1cbcc4c92593d85a84ee46becc6c AS build

ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2

ADD --checksum=sha256:f31b6997fdb098479ddddfca1267f02518ee0b59cc1d3f9682c3a48e6309f4d0 \
    https://codeload.github.com/minio/minio/tar.gz/7ced9663e6a791fef9dc6be798ff24cda9c730ac /tmp/minio.tar.gz
WORKDIR /src/minio
RUN tar -xzf /tmp/minio.tar.gz --strip-components=1 \
    && go build -p 2 -mod=readonly -trimpath -buildvcs=false \
       -ldflags="-s -w -X github.com/minio/minio/cmd.Version=2025-07-23T15:54:02Z -X github.com/minio/minio/cmd.ReleaseTag=RELEASE.2025-07-23T15-54-02Z -X github.com/minio/minio/cmd.CommitID=7ced9663e6a791fef9dc6be798ff24cda9c730ac" \
       -o /out/minio .

ADD --checksum=sha256:95cd293c7119f16921a6dc515a1fb74a2227f19fd994b9c8b770a154e802ac44 \
    https://codeload.github.com/minio/mc/tar.gz/7394ce0dd2a80935aded936b09fa12cbb3cb8096 /tmp/mc.tar.gz
WORKDIR /src/mc
RUN tar -xzf /tmp/mc.tar.gz --strip-components=1 \
    && go build -p 2 -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w" -o /out/mc .

FROM debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/minio /out/mc /usr/local/bin/
COPY --from=build /src/minio/LICENSE /usr/share/doc/minio/LICENSE
COPY --from=build /src/mc/LICENSE /usr/share/doc/mc/LICENSE
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      io.truerolls.fixture.minio.commit="7ced9663e6a791fef9dc6be798ff24cda9c730ac" \
      io.truerolls.fixture.mc.commit="7394ce0dd2a80935aded936b09fa12cbb3cb8096"

ENTRYPOINT ["/usr/local/bin/minio"]

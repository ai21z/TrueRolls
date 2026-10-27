# Local S3 Test Fixture

This image is only for development, controlled CI integration and isolated recovery rehearsals.
It is not a production storage recommendation or a release artifact.

The former `minio/minio` image and upstream legacy binary downloads are no longer available from
their original distribution endpoints. This fixture builds the same MinIO server release from
official upstream source instead of substituting an unverified third-party binary image:

| Component | Upstream release | Source commit |
| --- | --- | --- |
| MinIO server | RELEASE.2025-07-23T15-54-02Z | `7ced9663e6a791fef9dc6be798ff24cda9c730ac` |
| MinIO client | RELEASE.2025-08-13T08-35-41Z | `7394ce0dd2a80935aded936b09fa12cbb3cb8096` |

Both source archives have literal SHA-256 checksums enforced by Docker's `ADD --checksum`.
The compiler and runtime base images are digest-pinned, Go cannot download a different toolchain,
and module builds use the upstream `go.sum` with `-mod=readonly`. License texts are included in
the resulting image. Upstream sources: [MinIO](https://github.com/minio/minio/tree/7ced9663e6a791fef9dc6be798ff24cda9c730ac)
and [mc](https://github.com/minio/mc/tree/7394ce0dd2a80935aded936b09fa12cbb3cb8096).

This preserves a historical compatibility fixture, not a maintained or vulnerability-free storage
product. Build inputs are pinned; bit-identical output is not claimed. The first build downloads
and compiles Go dependencies and is slower than pulling a prebuilt image. Subsequent local builds
reuse Docker layers. The build context is this directory only and never includes `infra/.env`.

Both Compose files build this fixture automatically. It retains the `minio`, `mc`, shell and curl
interfaces used by bucket initialization and the backup/restore rehearsal. Do not publish this
test image or expose its development credentials as a public service.

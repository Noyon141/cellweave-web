# Canonical Artifact Publication Boundary (Phase 3 Step H.2)

## 1. Capability-Based Publication Boundary

Canonical dataset publication (`canonical.h5ad`) separates control-plane storage authority from science-plane artifact computation and verification:

- **`cellweave-web` (Control Plane / Storage Authority)**:
  - Validates `organizationId`, `projectId`, and `datasetVersionId`.
  - Derives the deterministic canonical R2 object key:
    `org/{organizationId}/project/{projectId}/datasets/{datasetVersionId}/canonical/canonical.h5ad`
  - Holds Cloudflare R2 credentials (`R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`).
  - Issues a short-lived `CanonicalArtifactPublicationCapabilities` contract containing presigned `putUrl` and `getUrl` URLs.

- **`cellweave-science` (Science Plane / Artifact Publisher)**:
  - Never receives Cloudflare R2 master credentials, bucket names, account IDs, or `boto3`.
  - Never constructs canonical R2 object keys or receives `organizationId` / `projectId` storage authority.
  - Receives only `local_artifact_path` and `CanonicalArtifactPublicationCapabilities`.
  - Streams the validated local `canonical.h5ad` directly to Cloudflare R2 over HTTPS and verifies remote integrity via streaming `GET`.

---

## 2. Conditional `PUT` & Signed Header Enforcement (`If-None-Match: *`)

`issueCanonicalArtifactPublicationCapabilities` in `src/server/integrations/storage/canonical-publication-capability.ts` presigns an S3 `PutObjectCommand` with:

- `IfNoneMatch: "*"`
- `ContentType: "application/x-hdf5"`
- `signableHeaders: new Set(["if-none-match", "content-type"])`

Because `if-none-match` and `content-type` are included in `X-Amz-SignedHeaders` (`content-type;host;if-none-match`), AWS SigV4 binds their exact header values into `X-Amz-Signature`:
- Any `PUT` request that omits or alters `If-None-Match: *` is rejected by Cloudflare R2 with `403 SignatureDoesNotMatch`.
- Any `PUT` request to an existing canonical object key is rejected by Cloudflare R2 with `412 Precondition Failed`, preventing silent overwrite of an existing `canonical.h5ad`.
- `S3Client` is configured with `requestChecksumCalculation: "WHEN_REQUIRED"` and `responseChecksumValidation: "WHEN_REQUIRED"` so presigned URLs are not bound to a dummy 0-byte CRC32 query parameter.

---

## 3. Read-After-Write Streaming `GET` Verification

`cellweave-science` never trusts HTTP `200 OK`, `ETag` headers, `Content-Length` headers, or custom object metadata as proof of remote integrity.

After every `PUT` attempt (`200/201/204` or `412 Precondition Failed`), `publish_canonical_artifact`:
1. Streams the remote object bytes from `capabilities.getUrl` in bounded chunks (`DEFAULT_CHUNK_SIZE_BYTES = 1 MiB`).
2. Computes the remote SHA-256 digest and exact remote byte count directly from the downloaded byte stream.
3. Compares `remote_byte_size == local_byte_size` and `remote_sha256 == local_sha256`.

---

## 4. Idempotent Retry vs Integrity Conflict Semantics

- **`PUBLISHED`**:
  - Conditional `PUT` succeeds (`200` / `201` / `204`) AND streaming `GET` verification confirms `remote_sha256 == local_sha256` and `remote_byte_size == local_byte_size`.
- **`ALREADY_PRESENT`**:
  - Conditional `PUT` returns `412 Precondition Failed` AND streaming `GET` verification confirms the existing remote object has the exact same `byteSize` and `SHA-256` as the local `canonical.h5ad`.
- **`CanonicalArtifactIntegrityError` (Hard Failure)**:
  - Raised when:
    - Conditional `PUT` returns `412 Precondition Failed` and the remote object has a different `byteSize` or `SHA-256` than the local file;
    - Conditional `PUT` succeeds (`2xx`) but streaming `GET` verification detects corrupted or truncated remote bytes;
    - The local `canonical.h5ad` file is mutated on disk during upload or verification.
  - Conflicting remote objects are never overwritten and `PUT` is never retried without `If-None-Match: *`.

---

## 5. Presigned URL Redaction

Presigned capability URLs (`putUrl` and `getUrl`) contain temporary cryptographic capability signatures (`X-Amz-Signature`, `X-Amz-Credential`). Both `redactCapabilityUrl` (`cellweave-web`) and `redact_capability_url` (`cellweave-science`) strip query parameters and fragments before formatting any error or diagnostic message.

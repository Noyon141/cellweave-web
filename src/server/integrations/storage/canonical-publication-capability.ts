import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { CanonicalArtifactPublicationCapabilities } from "@cellweave/contracts";
import { buildCanonicalDatasetKey } from "./object-key";
import { getR2BucketName, getR2Client } from "./r2-client";
import { sanitizeProviderError } from "./r2-storage-service";
import { STORAGE_DEFAULTS, StorageError } from "./storage-types";

/**
 * Trusted server-only input for issuing canonical artifact publication capabilities.
 *
 * Invariants:
 * 1. NEVER accepted from browser/client requests.
 * 2. Accepts only trusted server-side identifiers (organizationId, projectId, datasetVersionId).
 * 3. Never accepts arbitrary destination keys, file buffers, streams, or client checksums.
 */
export interface IssueCanonicalArtifactPublicationCapabilitiesParams {
  readonly organizationId: string;
  readonly projectId: string;
  readonly datasetVersionId: string;
  readonly expiresInSeconds?: number;
  readonly signingDate?: Date;
}

export interface CanonicalPublicationCapabilityDiagnosticEvent {
  readonly event: "canonical_publication.capabilities_issued";
  readonly datasetVersionId: string;
  readonly expiresAt: string;
  readonly expiresInSeconds: number;
  readonly operations: readonly ["PUT", "GET"];
}

export type CanonicalPublicationCapabilityDiagnosticLogger = (
  event: CanonicalPublicationCapabilityDiagnosticEvent
) => void;

export interface CanonicalPublicationCapabilityIssuerOptions {
  readonly client?: S3Client;
  readonly bucketName?: string;
  readonly presignFn?: typeof getSignedUrl;
  readonly now?: () => Date;
  readonly diagnosticLogger?: CanonicalPublicationCapabilityDiagnosticLogger;
}

/**
 * Redacts query parameters and embedded presigned signatures from a capability URL
 * so that full presigned URLs are never leaked in diagnostics or error messages.
 */
export function redactCapabilityUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}?<REDACTED_CAPABILITY_SIGNATURE>`;
  } catch {
    return "<REDACTED_CAPABILITY_URL>";
  }
}

/**
 * Verifies that a presigned conditional PUT URL cryptographically binds `if-none-match`
 * inside `X-Amz-SignedHeaders` so a caller cannot strip `If-None-Match: *` and convert
 * the capability into an unconditional overwrite.
 */
export function assertConditionalPutSignedHeaders(putUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(putUrl);
  } catch (error) {
    throw new StorageError(
      "Presigner returned an invalid PUT capability URL",
      "PROVIDER_ERROR",
      false,
      error
    );
  }

  const signedHeadersRaw =
    parsed.searchParams.get("X-Amz-SignedHeaders") ??
    parsed.searchParams.get("x-amz-signedheaders") ??
    "";

  const signedHeaders = signedHeadersRaw
    .split(";")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);

  if (!signedHeaders.includes("if-none-match") || !signedHeaders.includes("content-type")) {
    throw new StorageError(
      "Presigned PUT capability did not cryptographically bind required conditional headers (if-none-match, content-type)",
      "PROVIDER_ERROR",
      false
    );
  }
}

/**
 * Issues narrowly scoped, short-lived conditional PUT and GET capabilities for a single
 * deterministic canonical dataset artifact (`canonical.h5ad`).
 *
 * Architectural & Security Invariants:
 * 1. Derives the canonical R2 key strictly via `buildCanonicalDatasetKey`.
 * 2. Caller cannot supply an arbitrary object key, bucket, or file stream.
 * 3. Binds `If-None-Match: *` and `Content-Type: application/x-hdf5` into the SigV4 signature
 *    via `signableHeaders` and verifies `X-Amz-SignedHeaders` before returning.
 * 4. Returns only the `CanonicalArtifactPublicationCapabilities` contract (no `organizationId`,
 *    `projectId`, `bucket`, `r2Key`, or R2 credentials).
 * 5. Never logs full `putUrl`, `getUrl`, or signed query strings.
 */
export async function issueCanonicalArtifactPublicationCapabilities(
  params: IssueCanonicalArtifactPublicationCapabilitiesParams,
  options: CanonicalPublicationCapabilityIssuerOptions = {}
): Promise<CanonicalArtifactPublicationCapabilities> {
  // Reject any unexpected caller properties (e.g. r2Key, bucket, fileBytes, canonicalChecksum)
  const allowedParamKeys = new Set([
    "organizationId",
    "projectId",
    "datasetVersionId",
    "expiresInSeconds",
    "signingDate",
  ]);
  for (const key of Object.keys(params as unknown as Record<string, unknown>)) {
    if (!allowedParamKeys.has(key)) {
      throw new StorageError(
        `Unexpected parameter '${key}' in capability issuance request`,
        "INVALID_OBJECT_KEY"
      );
    }
  }

  const expiresInSeconds =
    params.expiresInSeconds ?? STORAGE_DEFAULTS.CANONICAL_PUBLICATION_CAPABILITY_EXPIRES_SECONDS;

  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds <= 0 ||
    expiresInSeconds > STORAGE_DEFAULTS.MAX_CANONICAL_PUBLICATION_CAPABILITY_EXPIRES_SECONDS
  ) {
    throw new StorageError(
      `expiresInSeconds must be a positive integer up to ${STORAGE_DEFAULTS.MAX_CANONICAL_PUBLICATION_CAPABILITY_EXPIRES_SECONDS}`,
      "INVALID_OBJECT_KEY"
    );
  }

  // 1. Validate identifiers and build deterministic canonical object key
  const canonicalKey = buildCanonicalDatasetKey({
    organizationId: params.organizationId,
    projectId: params.projectId,
    datasetVersionId: params.datasetVersionId,
  });

  const client = options.client ?? getR2Client();
  const bucketName = options.bucketName ?? getR2BucketName();
  const presign = options.presignFn ?? getSignedUrl;
  const issuedAt = params.signingDate ?? (options.now ? options.now() : new Date());

  if (!(issuedAt instanceof Date) || Number.isNaN(issuedAt.getTime())) {
    throw new StorageError("Invalid signingDate for capability issuance", "INVALID_OBJECT_KEY");
  }

  const expiresAtDate = new Date(issuedAt.getTime() + expiresInSeconds * 1000);
  const expiresAt = expiresAtDate.toISOString();

  const contentType = STORAGE_DEFAULTS.CANONICAL_H5AD_CONTENT_TYPE;

  try {
    // 2. Create conditional PUT capability with If-None-Match: * bound into signed headers
    const putCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: canonicalKey,
      IfNoneMatch: "*",
      ContentType: contentType,
    });

    const putUrl = await presign(client, putCommand, {
      expiresIn: expiresInSeconds,
      signingDate: issuedAt,
      signableHeaders: new Set(["if-none-match", "content-type"]),
    });

    assertConditionalPutSignedHeaders(putUrl);

    // 3. Create GET capability targeting the exact same canonical object key
    const getCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: canonicalKey,
    });

    const getUrl = await presign(client, getCommand, {
      expiresIn: expiresInSeconds,
      signingDate: issuedAt,
    });

    if (options.diagnosticLogger) {
      options.diagnosticLogger({
        event: "canonical_publication.capabilities_issued",
        datasetVersionId: params.datasetVersionId,
        expiresAt,
        expiresInSeconds,
        operations: ["PUT", "GET"],
      });
    }

    return {
      datasetVersionId: params.datasetVersionId,
      putUrl,
      getUrl,
      expiresAt,
      requiredPutHeaders: {
        "If-None-Match": "*",
        "Content-Type": contentType,
      },
      requiredGetHeaders: {},
    };
  } catch (error) {
    throw sanitizeProviderError(error, "PROVIDER_ERROR");
  }
}

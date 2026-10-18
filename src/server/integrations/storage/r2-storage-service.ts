import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  GetObjectCommand,
  type ListPartsCommandOutput,
  type CompletedPart as S3CompletedPart,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  S3_PROTOCOL_LIMITS,
  STORAGE_DEFAULTS,
  StorageError,
  type StorageErrorCode,
  type StorageService,
  type CreateMultipartUploadParams,
  type CreateMultipartUploadResult,
  type CreatePresignedUploadPartUrlParams,
  type ListMultipartPartsParams,
  type UploadedPartEntry,
  type CompleteMultipartUploadParams,
  type CompleteMultipartUploadResult,
  type AbortMultipartUploadParams,
  type HeadObjectParams,
  type HeadObjectResult,
  type CreatePresignedDownloadUrlParams,
} from "./storage-types";
import { getR2Client, getR2BucketName } from "./r2-client";

/**
 * Maps raw provider / AWS SDK errors into sanitized, typed CellWeave StorageErrors.
 * Strictly guarantees that sensitive credentials, query strings, and raw response
 * payloads are never leaked to callers or logs.
 */
export function sanitizeProviderError(
  error: unknown,
  defaultCode: StorageErrorCode = "PROVIDER_ERROR"
): StorageError {
  if (error instanceof StorageError) {
    return error;
  }

  const err = error as {
    name?: string;
    code?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const name = err.name || err.code || "";
  const status = err.$metadata?.httpStatusCode;

  if (name === "NoSuchUpload") {
    return new StorageError(
      "The multipart upload was not found or has already expired/aborted",
      "MULTIPART_UPLOAD_NOT_FOUND",
      false,
      error
    );
  }

  if (name === "NotFound" || name === "NoSuchKey" || status === 404) {
    return new StorageError(
      "The requested storage object was not found",
      "OBJECT_NOT_FOUND",
      false,
      error
    );
  }

  if (name === "InvalidPart" || name === "InvalidPartOrder") {
    return new StorageError(
      "One or more multipart parts are invalid, missing, or improperly ordered",
      "INVALID_PART",
      false,
      error
    );
  }

  if (
    name === "InvalidAccessKeyId" ||
    name === "SignatureDoesNotMatch" ||
    status === 401 ||
    status === 403
  ) {
    return new StorageError(
      "Storage provider authentication or authorization failed",
      "PROVIDER_AUTH_ERROR",
      false,
      error
    );
  }

  if (name === "SlowDown" || name === "ServiceUnavailable" || status === 503) {
    return new StorageError(
      "Storage provider is temporarily unavailable or rate-limited",
      "PROVIDER_UNAVAILABLE",
      true,
      error
    );
  }

  return new StorageError(
    "A storage provider operation failed",
    defaultCode,
    status !== undefined && status >= 500,
    error
  );
}

/**
 * Cloudflare R2 Multipart Storage Service Implementation
 *
 * Invariants:
 * 1. Operates solely over private R2 buckets via presigned authorization.
 * 2. Never accepts or buffers raw scientific data buffers in Next.js.
 * 3. Sanitizes all provider exceptions into typed StorageErrors.
 * 4. Never exposes or logs presigned URL credentials.
 */
export class R2StorageService implements StorageService {
  private readonly client: S3Client;
  private readonly bucketName: string;

  constructor(client: S3Client = getR2Client(), bucketName: string = getR2BucketName()) {
    this.client = client;
    this.bucketName = bucketName;
  }

  /**
   * Initiates a multipart upload in R2.
   */
  async createMultipartUpload(
    params: CreateMultipartUploadParams
  ): Promise<CreateMultipartUploadResult> {
    const { objectKey, contentType, metadata } = params;

    if (!objectKey || objectKey.trim().length === 0) {
      throw new StorageError(
        "objectKey is required to initiate multipart upload",
        "INVALID_OBJECT_KEY"
      );
    }

    try {
      const command = new CreateMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: objectKey,
        ContentType: contentType,
        Metadata: metadata ? { ...metadata } : undefined,
      });

      const response = await this.client.send(command);

      if (!response.UploadId) {
        throw new StorageError(
          "Provider did not return an uploadId for multipart upload",
          "PROVIDER_ERROR"
        );
      }

      return {
        uploadId: response.UploadId,
        objectKey,
      };
    } catch (error) {
      throw sanitizeProviderError(error, "PROVIDER_ERROR");
    }
  }

  /**
   * Generates a short-lived presigned URL for direct browser-to-R2 upload of a single part.
   */
  async createPresignedUploadPartUrl(params: CreatePresignedUploadPartUrlParams): Promise<string> {
    const {
      objectKey,
      uploadId,
      partNumber,
      expiresInSeconds = STORAGE_DEFAULTS.PRESIGNED_UPLOAD_PART_EXPIRES_SECONDS,
    } = params;

    if (!objectKey || objectKey.trim().length === 0) {
      throw new StorageError("objectKey is required", "INVALID_OBJECT_KEY");
    }
    if (!uploadId || uploadId.trim().length === 0) {
      throw new StorageError("uploadId is required", "MULTIPART_UPLOAD_NOT_FOUND");
    }

    if (
      !Number.isInteger(partNumber) ||
      partNumber < S3_PROTOCOL_LIMITS.MIN_PART_NUMBER ||
      partNumber > S3_PROTOCOL_LIMITS.MAX_PARTS
    ) {
      throw new StorageError(
        `partNumber must be an integer between ${S3_PROTOCOL_LIMITS.MIN_PART_NUMBER} and ${S3_PROTOCOL_LIMITS.MAX_PARTS}`,
        "INVALID_PART"
      );
    }

    try {
      const command = new UploadPartCommand({
        Bucket: this.bucketName,
        Key: objectKey,
        UploadId: uploadId,
        PartNumber: partNumber,
      });

      return await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
    } catch (error) {
      throw sanitizeProviderError(error, "PROVIDER_ERROR");
    }
  }

  /**
   * Queries Cloudflare R2 for all uploaded parts in this multipart session.
   * Handles provider pagination and returns parts sorted ascending by partNumber.
   */
  async listMultipartParts(
    params: ListMultipartPartsParams
  ): Promise<readonly UploadedPartEntry[]> {
    const { objectKey, uploadId } = params;

    if (!objectKey || objectKey.trim().length === 0) {
      throw new StorageError("objectKey is required", "INVALID_OBJECT_KEY");
    }
    if (!uploadId || uploadId.trim().length === 0) {
      throw new StorageError("uploadId is required", "MULTIPART_UPLOAD_NOT_FOUND");
    }

    const allParts: UploadedPartEntry[] = [];
    let isTruncated = true;
    let nextPartNumberMarker: string | undefined = undefined;

    try {
      while (isTruncated) {
        const listCommand: ListPartsCommand = new ListPartsCommand({
          Bucket: this.bucketName,
          Key: objectKey,
          UploadId: uploadId,
          PartNumberMarker: nextPartNumberMarker,
        });

        const response: ListPartsCommandOutput = await this.client.send(listCommand);

        if (response.Parts) {
          for (const p of response.Parts) {
            if (p.PartNumber === undefined || !p.ETag) {
              continue;
            }
            allParts.push({
              partNumber: p.PartNumber,
              // Normalize provider ETag by stripping enclosing quotes if present
              eTag: p.ETag.replace(/^"|"$/g, ""),
              sizeBytes: p.Size,
              lastModified: p.LastModified,
            });
          }
        }

        isTruncated = response.IsTruncated ?? false;
        nextPartNumberMarker = response.NextPartNumberMarker
          ? String(response.NextPartNumberMarker)
          : undefined;

        if (isTruncated && !nextPartNumberMarker) {
          // Fallback marker to the last received part number if provider omitted NextPartNumberMarker
          const lastPart = allParts[allParts.length - 1];
          if (lastPart) {
            nextPartNumberMarker = String(lastPart.partNumber);
          } else {
            break;
          }
        }
      }

      // Sort ascending by part number
      allParts.sort((a, b) => a.partNumber - b.partNumber);

      return allParts;
    } catch (error) {
      throw sanitizeProviderError(error, "MULTIPART_UPLOAD_NOT_FOUND");
    }
  }

  /**
   * Finalizes the multipart upload in R2 with the ordered list of completed parts.
   */
  async completeMultipartUpload(
    params: CompleteMultipartUploadParams
  ): Promise<CompleteMultipartUploadResult> {
    const { objectKey, uploadId, parts } = params;

    if (!objectKey || objectKey.trim().length === 0) {
      throw new StorageError("objectKey is required", "INVALID_OBJECT_KEY");
    }
    if (!uploadId || uploadId.trim().length === 0) {
      throw new StorageError("uploadId is required", "MULTIPART_UPLOAD_NOT_FOUND");
    }
    if (!parts || parts.length === 0) {
      throw new StorageError(
        "At least one part is required to complete multipart upload",
        "INVALID_PART"
      );
    }

    // Defensive validation: check for duplicates and empty ETags
    const seenPartNumbers = new Set<number>();
    const normalizedParts: S3CompletedPart[] = [];

    for (const p of parts) {
      if (!Number.isInteger(p.partNumber) || p.partNumber < S3_PROTOCOL_LIMITS.MIN_PART_NUMBER) {
        throw new StorageError(`Invalid part number: ${p.partNumber}`, "INVALID_PART");
      }
      if (seenPartNumbers.has(p.partNumber)) {
        throw new StorageError(`Duplicate part number detected: ${p.partNumber}`, "INVALID_PART");
      }
      seenPartNumbers.add(p.partNumber);

      if (!p.eTag || p.eTag.trim().length === 0) {
        throw new StorageError(`Missing or empty ETag for part ${p.partNumber}`, "INVALID_PART");
      }

      // Ensure ETag has double-quote delimiters for S3/R2 CompleteMultipartUpload specification
      const rawEtag = p.eTag.trim();
      const quotedEtag =
        rawEtag.startsWith('"') && rawEtag.endsWith('"') ? rawEtag : `"${rawEtag}"`;

      normalizedParts.push({
        PartNumber: p.partNumber,
        ETag: quotedEtag,
      });
    }

    // Sort parts ascending by PartNumber
    normalizedParts.sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0));

    try {
      const command = new CompleteMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: objectKey,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: normalizedParts,
        },
      });

      const response = await this.client.send(command);

      const finalEtag = (response.ETag ?? "").replace(/^"|"$/g, "");

      return {
        objectKey,
        eTag: finalEtag,
        location: response.Location,
      };
    } catch (error) {
      throw sanitizeProviderError(error, "PROVIDER_ERROR");
    }
  }

  /**
   * Aborts an active multipart upload and frees incomplete part storage in R2.
   */
  async abortMultipartUpload(params: AbortMultipartUploadParams): Promise<void> {
    const { objectKey, uploadId } = params;

    if (!objectKey || objectKey.trim().length === 0) {
      throw new StorageError("objectKey is required", "INVALID_OBJECT_KEY");
    }
    if (!uploadId || uploadId.trim().length === 0) {
      throw new StorageError("uploadId is required", "MULTIPART_UPLOAD_NOT_FOUND");
    }

    try {
      const command = new AbortMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: objectKey,
        UploadId: uploadId,
      });

      await this.client.send(command);
    } catch (error) {
      throw sanitizeProviderError(error, "MULTIPART_UPLOAD_NOT_FOUND");
    }
  }

  /**
   * Retrieves metadata of an object in R2 to verify completion and size.
   * Returns null if the object does not exist.
   */
  async headObject(params: HeadObjectParams): Promise<HeadObjectResult | null> {
    const { objectKey } = params;

    if (!objectKey || objectKey.trim().length === 0) {
      throw new StorageError("objectKey is required", "INVALID_OBJECT_KEY");
    }

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
      });

      const response = await this.client.send(command);

      return {
        objectKey,
        contentLength: response.ContentLength ?? 0,
        eTag: (response.ETag ?? "").replace(/^"|"$/g, ""),
        contentType: response.ContentType,
        lastModified: response.LastModified,
      };
    } catch (error) {
      const mapped = sanitizeProviderError(error, "PROVIDER_ERROR");
      if (mapped.code === "OBJECT_NOT_FOUND") {
        return null;
      }
      throw mapped;
    }
  }

  /**
   * Creates a short-lived presigned URL for downloading an authorized private R2 object.
   * Note: The calling application service is strictly responsible for performing tenant and
   * project access authorization prior to calling this method.
   */
  async createPresignedDownloadUrl(params: CreatePresignedDownloadUrlParams): Promise<string> {
    const { objectKey, expiresInSeconds = STORAGE_DEFAULTS.PRESIGNED_DOWNLOAD_EXPIRES_SECONDS } =
      params;

    if (!objectKey || objectKey.trim().length === 0) {
      throw new StorageError("objectKey is required", "INVALID_OBJECT_KEY");
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
      });

      return await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
    } catch (error) {
      throw sanitizeProviderError(error, "PROVIDER_ERROR");
    }
  }
}

let storageServiceInstance: R2StorageService | null = null;

export function getR2StorageService(): StorageService {
  if (!storageServiceInstance) {
    storageServiceInstance = new R2StorageService();
  }
  return storageServiceInstance;
}

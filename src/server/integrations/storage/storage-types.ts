/**
 * Storage Abstraction Types & Protocol Limits (System Design §122)
 * Strictly separates Cloudflare R2 / S3 protocol constraints from CellWeave operational policies.
 */

// ============================================================================
// 1. PROTOCOL LIMITS (Cloudflare R2 / S3 Multipart Specification)
// ============================================================================
export const S3_PROTOCOL_LIMITS = {
  /** Maximum number of parts allowed in a single multipart upload (10,000) */
  MAX_PARTS: 10_000,
  /** Minimum part number (1-based index) */
  MIN_PART_NUMBER: 1,
  /** Minimum part size in bytes for all parts except the final part (5 MiB) */
  MIN_PART_SIZE_BYTES: 5 * 1024 * 1024,
  /** Maximum single part size in bytes (5 GiB) */
  MAX_PART_SIZE_BYTES: 5 * 1024 * 1024 * 1024,
  /** Maximum single object size in bytes (5 TiB) */
  MAX_OBJECT_SIZE_BYTES: 5 * 1024 * 1024 * 1024 * 1024,
} as const;

// ============================================================================
// 2. CELLWEAVE OPERATIONAL POLICIES (Configurable Defaults)
// ============================================================================
export const STORAGE_DEFAULTS = {
  /** Default lifetime for presigned UploadPart URLs: 15 minutes (900 seconds) */
  PRESIGNED_UPLOAD_PART_EXPIRES_SECONDS: 15 * 60,
  /** Default lifetime for presigned Download URLs: 5 minutes (300 seconds) */
  PRESIGNED_DOWNLOAD_EXPIRES_SECONDS: 5 * 60,
  /** Maximum allowed filename length in UTF-8 bytes/characters */
  MAX_FILENAME_LENGTH: 255,
} as const;

// ============================================================================
// 3. STORAGE ERROR CATEGORIES & SANITIZED ERROR CLASS
// ============================================================================
export type StorageErrorCode =
  | "OBJECT_NOT_FOUND"
  | "MULTIPART_UPLOAD_NOT_FOUND"
  | "INVALID_PART"
  | "INVALID_OBJECT_KEY"
  | "INVALID_FILENAME"
  | "PROVIDER_AUTH_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_ERROR";

export class StorageError extends Error {
  public readonly code: StorageErrorCode;
  public readonly isRetryable: boolean;

  constructor(
    message: string,
    code: StorageErrorCode,
    isRetryable: boolean = false,
    cause?: unknown
  ) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.isRetryable = isRetryable;
    if (cause !== undefined) {
      this.cause = cause;
    }
    Object.setPrototypeOf(this, StorageError.prototype);
  }
}

// ============================================================================
// 4. STORAGE ADAPTER INPUT & OUTPUT INTERFACES
// ============================================================================

export interface CreateMultipartUploadParams {
  readonly objectKey: string;
  readonly contentType: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CreateMultipartUploadResult {
  readonly uploadId: string;
  readonly objectKey: string;
}

export interface CreatePresignedUploadPartUrlParams {
  readonly objectKey: string;
  readonly uploadId: string;
  readonly partNumber: number;
  readonly expiresInSeconds?: number;
}

export interface UploadedPartEntry {
  readonly partNumber: number;
  readonly eTag: string;
  readonly sizeBytes?: number;
  readonly lastModified?: Date;
}

export interface ListMultipartPartsParams {
  readonly objectKey: string;
  readonly uploadId: string;
}

export interface CompletedPart {
  readonly partNumber: number;
  readonly eTag: string;
}

export interface CompleteMultipartUploadParams {
  readonly objectKey: string;
  readonly uploadId: string;
  readonly parts: readonly CompletedPart[];
}

export interface CompleteMultipartUploadResult {
  readonly objectKey: string;
  readonly eTag: string;
  readonly location?: string;
}

export interface AbortMultipartUploadParams {
  readonly objectKey: string;
  readonly uploadId: string;
}

export interface HeadObjectParams {
  readonly objectKey: string;
}

export interface HeadObjectResult {
  readonly objectKey: string;
  readonly contentLength: number;
  readonly eTag: string;
  readonly contentType?: string;
  readonly lastModified?: Date;
}

export interface CreatePresignedDownloadUrlParams {
  readonly objectKey: string;
  readonly expiresInSeconds?: number;
}

/**
 * Low-level Storage Service Interface
 * Business application services interact strictly through this boundary.
 */
export interface StorageService {
  createMultipartUpload(params: CreateMultipartUploadParams): Promise<CreateMultipartUploadResult>;
  createPresignedUploadPartUrl(params: CreatePresignedUploadPartUrlParams): Promise<string>;
  listMultipartParts(params: ListMultipartPartsParams): Promise<readonly UploadedPartEntry[]>;
  completeMultipartUpload(
    params: CompleteMultipartUploadParams
  ): Promise<CompleteMultipartUploadResult>;
  abortMultipartUpload(params: AbortMultipartUploadParams): Promise<void>;
  headObject(params: HeadObjectParams): Promise<HeadObjectResult | null>;
  createPresignedDownloadUrl(params: CreatePresignedDownloadUrlParams): Promise<string>;
}

export interface CreateUploadParams {
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string;
  readonly expiresInSeconds?: number;
}

export interface CreateUploadResult {
  readonly uploadUrl: string;
  readonly key: string;
  readonly expiresInSeconds: number;
}

export interface CompleteUploadParams {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId?: string;
  readonly parts?: readonly { readonly partNumber: number; readonly etag: string }[];
}

export interface CreateDownloadUrlParams {
  readonly bucket: string;
  readonly key: string;
  readonly expiresInSeconds?: number;
}

export interface ObjectMetadata {
  readonly key: string;
  readonly sizeBytes: number;
  readonly lastModified?: Date;
  readonly etag?: string;
  readonly contentType?: string;
}

/**
 * Storage Interface (System Design §122)
 * Abstract object storage contract. Business services interact only with this interface,
 * preventing Cloudflare R2 vendor lock-in.
 */
export interface ObjectStorage {
  createUpload(params: CreateUploadParams): Promise<CreateUploadResult>;
  completeUpload(
    params: CompleteUploadParams
  ): Promise<{ readonly key: string; readonly location?: string }>;
  createDownloadUrl(params: CreateDownloadUrlParams): Promise<string>;
  headObject(bucket: string, key: string): Promise<ObjectMetadata | null>;
  deleteObject(bucket: string, key: string): Promise<void>;
  copyObject(
    sourceBucket: string,
    sourceKey: string,
    destBucket: string,
    destKey: string
  ): Promise<void>;
}

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  ObjectStorage,
  CreateUploadParams,
  CreateUploadResult,
  CompleteUploadParams,
  CreateDownloadUrlParams,
  ObjectMetadata,
} from "./object-storage";
import { env } from "../config/env";

export class R2ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(
    accountId: string = env.R2_ACCOUNT_ID,
    accessKeyId: string = env.R2_ACCESS_KEY_ID,
    secretAccessKey: string = env.R2_SECRET_ACCESS_KEY
  ) {
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  async createUpload(params: CreateUploadParams): Promise<CreateUploadResult> {
    const expiresIn = params.expiresInSeconds ?? 3600;
    const command = new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      ContentType: params.contentType,
    });

    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn });
    return {
      uploadUrl,
      key: params.key,
      expiresInSeconds: expiresIn,
    };
  }

  async completeUpload(
    params: CompleteUploadParams
  ): Promise<{ readonly key: string; readonly location?: string }> {
    // For single-part put, head ensures upload exists
    const metadata = await this.headObject(params.bucket, params.key);
    if (!metadata) {
      throw new Error(`Upload verification failed for object: ${params.key}`);
    }
    return { key: params.key };
  }

  async createDownloadUrl(params: CreateDownloadUrlParams): Promise<string> {
    const expiresIn = params.expiresInSeconds ?? 900; // Default 15-minute short-lived URL
    const command = new GetObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
    });

    return await getSignedUrl(this.client, command, { expiresIn });
  }

  async headObject(bucket: string, key: string): Promise<ObjectMetadata | null> {
    try {
      const command = new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      const response = await this.client.send(command);
      return {
        key,
        sizeBytes: response.ContentLength ?? 0,
        lastModified: response.LastModified,
        etag: response.ETag,
        contentType: response.ContentType,
      };
    } catch {
      return null;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    await this.client.send(command);
  }

  async copyObject(
    sourceBucket: string,
    sourceKey: string,
    destBucket: string,
    destKey: string
  ): Promise<void> {
    const command = new CopyObjectCommand({
      CopySource: `${sourceBucket}/${sourceKey}`,
      Bucket: destBucket,
      Key: destKey,
    });
    await this.client.send(command);
  }
}

let r2Instance: R2ObjectStorage | null = null;

export function getObjectStorage(): ObjectStorage {
  if (!r2Instance) {
    r2Instance = new R2ObjectStorage();
  }
  return r2Instance;
}

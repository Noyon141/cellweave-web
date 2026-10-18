import { S3Client } from "@aws-sdk/client-s3";
import { env } from "../../config/env";

export interface R2ClientConfig {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucketName: string;
}

let cachedS3Client: S3Client | null = null;

/**
 * Creates or retrieves the singleton server-side S3Client configured for Cloudflare R2.
 *
 * Invariants:
 * 1. Marked "server-only" to ensure credentials never enter client bundles.
 * 2. Endpoint is dynamically derived as https://<accountId>.r2.cloudflarestorage.com.
 * 3. Region is fixed to "auto" per Cloudflare R2 specification.
 * 4. Credentials are strictly sourced from validated environment variables.
 */
export function getR2Client(customConfig?: Partial<R2ClientConfig>): S3Client {
  if (customConfig) {
    const accountId = customConfig.accountId ?? env.R2_ACCOUNT_ID;
    const accessKeyId = customConfig.accessKeyId ?? env.R2_ACCESS_KEY_ID;
    const secretAccessKey = customConfig.secretAccessKey ?? env.R2_SECRET_ACCESS_KEY;

    return new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  if (!cachedS3Client) {
    cachedS3Client = new S3Client({
      region: "auto",
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }

  return cachedS3Client;
}

export function getR2BucketName(): string {
  return env.R2_BUCKET_NAME;
}

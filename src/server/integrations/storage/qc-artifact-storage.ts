import "server-only";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { QcArtifactTarget, QcArtifactInput } from "@cellweave/contracts";
import { R2StorageService } from "./r2-storage-service";
import { getR2Client, getR2BucketName } from "./r2-client";
import { assertConditionalPutSignedHeaders } from "./conditional-signed-headers";
import { ValidationError } from "../../authorization/errors";
export interface QcArtifactStorage {
  bucket(): string;
  size(key: string): Promise<number>;
  download(key: string, ttl: number): Promise<string>;
  input(
    fact: {
      id: string;
      artifactType: "CANONICAL_DATASET" | "QC_REPORT" | "FILTERED_DATASET";
      objectKey: string;
      sha256: string;
      sizeBytes: number;
    },
    ttl: number
  ): Promise<QcArtifactInput>;
  target(
    id: string,
    type: "QC_REPORT" | "FILTERED_DATASET",
    fileName: QcArtifactTarget["fileName"],
    key: string,
    ttl: number
  ): Promise<QcArtifactTarget>;
}
export function buildQcArtifactKey(
  org: string,
  project: string,
  run: string,
  id: string,
  fileName: QcArtifactTarget["fileName"]
): string {
  if ([org, project, run, id].some((value) => !/^[A-Za-z0-9_-]+$/.test(value)))
    throw new ValidationError("Invalid artifact identity");
  return `org/${org}/project/${project}/runs/${run}/artifacts/${id}/${fileName}`;
}
export class R2QcArtifactStorage implements QcArtifactStorage {
  bucket() {
    return getR2BucketName();
  }
  async download(key: string, ttl: number) {
    return new R2StorageService().createPresignedDownloadUrl({
      objectKey: key,
      expiresInSeconds: ttl,
    });
  }
  async size(key: string) {
    const fact = await new R2StorageService().headObject({ objectKey: key });
    if (!fact || !Number.isSafeInteger(fact.contentLength) || fact.contentLength <= 0)
      throw new ValidationError("Canonical artifact unavailable");
    return fact.contentLength;
  }
  async input(
    fact: Parameters<QcArtifactStorage["input"]>[0],
    ttl: number
  ): Promise<QcArtifactInput> {
    if (fact.artifactType === "FILTERED_DATASET") throw new ValidationError("Invalid QC input");
    return {
      artifactId: fact.id,
      type: fact.artifactType,
      sha256: fact.sha256,
      byteSize: fact.sizeBytes,
      downloadUrl: await new R2StorageService().createPresignedDownloadUrl({
        objectKey: fact.objectKey,
        expiresInSeconds: ttl,
      }),
    };
  }
  async target(
    id: string,
    type: "QC_REPORT" | "FILTERED_DATASET",
    fileName: QcArtifactTarget["fileName"],
    key: string,
    ttl: number
  ): Promise<QcArtifactTarget> {
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 3600)
      throw new ValidationError("Invalid artifact capability lifetime");
    const client = getR2Client(),
      Bucket = this.bucket();
    const putUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket,
        Key: key,
        IfNoneMatch: "*",
        ContentType: fileName.endsWith("h5ad")
          ? "application/x-hdf5"
          : fileName.endsWith("gz")
            ? "application/gzip"
            : "application/json",
      }),
      { expiresIn: ttl, signableHeaders: new Set(["if-none-match", "content-type"]) }
    );
    assertConditionalPutSignedHeaders(putUrl);
    return {
      artifactId: id,
      type,
      fileName,
      putUrl,
      getUrl: await getSignedUrl(client, new GetObjectCommand({ Bucket, Key: key }), {
        expiresIn: ttl,
      }),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      ifNoneMatch: "*",
    };
  }
}

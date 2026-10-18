import { describe, it, expect, vi, beforeEach } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import {
  R2StorageService,
  sanitizeProviderError,
} from "@/server/integrations/storage/r2-storage-service";
import { StorageError, S3_PROTOCOL_LIMITS } from "@/server/integrations/storage/storage-types";

// Mock @aws-sdk/s3-request-presigner
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockImplementation(async (_client, command, options) => {
    return `https://mock-presigned-url.r2.internal/${command.input?.Key}?expiresIn=${options?.expiresIn}&partNumber=${command.input?.PartNumber || ""}&uploadId=${command.input?.UploadId || ""}`;
  }),
}));

describe("R2StorageService Unit & Provider Contract Tests (Step E)", () => {
  let mockS3Client: { send: ReturnType<typeof vi.fn> };
  let storageService: R2StorageService;
  const testBucket = "cellweave-test-bucket";

  beforeEach(() => {
    mockS3Client = {
      send: vi.fn(),
    };
    storageService = new R2StorageService(mockS3Client as unknown as S3Client, testBucket);
  });

  describe("createMultipartUpload", () => {
    it("successfully initiates multipart upload and returns uploadId", async () => {
      mockS3Client.send.mockResolvedValueOnce({
        UploadId: "mock_upl_12345",
      });

      const result = await storageService.createMultipartUpload({
        objectKey: "org/org_1/project/proj_1/datasets/dsv_1/source/matrix.h5ad",
        contentType: "application/x-hdf5",
        metadata: { client: "cellweave-web" },
      });

      expect(result.uploadId).toBe("mock_upl_12345");
      expect(result.objectKey).toBe("org/org_1/project/proj_1/datasets/dsv_1/source/matrix.h5ad");
      expect(mockS3Client.send).toHaveBeenCalledTimes(1);
    });

    it("rejects empty objectKey", async () => {
      await expect(
        storageService.createMultipartUpload({
          objectKey: "",
          contentType: "application/octet-stream",
        })
      ).rejects.toThrow(StorageError);
    });

    it("maps provider auth error into sanitized StorageError", async () => {
      mockS3Client.send.mockRejectedValueOnce({
        name: "InvalidAccessKeyId",
        $metadata: { httpStatusCode: 403 },
      });

      await expect(
        storageService.createMultipartUpload({
          objectKey: "test/key",
          contentType: "application/octet-stream",
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          code: "PROVIDER_AUTH_ERROR",
        })
      );
    });
  });

  describe("createPresignedUploadPartUrl", () => {
    it("generates presigned upload part URL with short expiration", async () => {
      const url = await storageService.createPresignedUploadPartUrl({
        objectKey: "test/key",
        uploadId: "mock_upl_123",
        partNumber: 1,
        expiresInSeconds: 900,
      });

      expect(url).toContain("https://mock-presigned-url.r2.internal/test/key");
      expect(url).toContain("expiresIn=900");
      expect(url).toContain("partNumber=1");
    });

    it("rejects part numbers less than 1 or exceeding 10,000", async () => {
      await expect(
        storageService.createPresignedUploadPartUrl({
          objectKey: "test/key",
          uploadId: "mock_upl_123",
          partNumber: 0,
        })
      ).rejects.toThrow(StorageError);

      await expect(
        storageService.createPresignedUploadPartUrl({
          objectKey: "test/key",
          uploadId: "mock_upl_123",
          partNumber: S3_PROTOCOL_LIMITS.MAX_PARTS + 1,
        })
      ).rejects.toThrow(StorageError);
    });
  });

  describe("listMultipartParts", () => {
    it("handles multi-page pagination and returns parts sorted ascending", async () => {
      // First page response
      mockS3Client.send.mockResolvedValueOnce({
        IsTruncated: true,
        NextPartNumberMarker: 2,
        Parts: [
          {
            PartNumber: 2,
            ETag: '"etag-2"',
            Size: 5242880,
            LastModified: new Date("2026-01-01T00:00:00Z"),
          },
          {
            PartNumber: 1,
            ETag: '"etag-1"',
            Size: 5242880,
            LastModified: new Date("2026-01-01T00:00:00Z"),
          },
        ],
      });

      // Second page response
      mockS3Client.send.mockResolvedValueOnce({
        IsTruncated: false,
        Parts: [
          {
            PartNumber: 3,
            ETag: '"etag-3"',
            Size: 2048,
            LastModified: new Date("2026-01-01T00:00:00Z"),
          },
        ],
      });

      const parts = await storageService.listMultipartParts({
        objectKey: "test/key",
        uploadId: "mock_upl_123",
      });

      expect(parts).toHaveLength(3);
      const [part1, part2, part3] = parts;
      expect(part1).toBeDefined();
      expect(part2).toBeDefined();
      expect(part3).toBeDefined();
      expect(part1?.partNumber).toBe(1);
      expect(part1?.eTag).toBe("etag-1");
      expect(part2?.partNumber).toBe(2);
      expect(part2?.eTag).toBe("etag-2");
      expect(part3?.partNumber).toBe(3);
      expect(part3?.eTag).toBe("etag-3");
      expect(mockS3Client.send).toHaveBeenCalledTimes(2);
    });

    it("maps NoSuchUpload into MULTIPART_UPLOAD_NOT_FOUND error", async () => {
      mockS3Client.send.mockRejectedValueOnce({
        name: "NoSuchUpload",
        $metadata: { httpStatusCode: 404 },
      });

      await expect(
        storageService.listMultipartParts({
          objectKey: "test/key",
          uploadId: "expired_upl",
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          code: "MULTIPART_UPLOAD_NOT_FOUND",
        })
      );
    });
  });

  describe("completeMultipartUpload", () => {
    it("sorts parts ascending, normalizes quotes, and calls complete", async () => {
      mockS3Client.send.mockResolvedValueOnce({
        ETag: '"final-composite-etag"',
        Location: "https://r2.internal/test/key",
      });

      const result = await storageService.completeMultipartUpload({
        objectKey: "test/key",
        uploadId: "mock_upl_123",
        parts: [
          { partNumber: 2, eTag: "raw-etag-2" },
          { partNumber: 1, eTag: '"already-quoted-etag-1"' },
        ],
      });

      expect(result.objectKey).toBe("test/key");
      expect(result.eTag).toBe("final-composite-etag");

      const call = mockS3Client.send.mock.calls[0];
      expect(call).toBeDefined();
      const sentCommand = call?.[0];
      expect(sentCommand?.input?.MultipartUpload?.Parts).toEqual([
        { PartNumber: 1, ETag: '"already-quoted-etag-1"' },
        { PartNumber: 2, ETag: '"raw-etag-2"' },
      ]);
    });

    it("rejects duplicate part numbers", async () => {
      await expect(
        storageService.completeMultipartUpload({
          objectKey: "test/key",
          uploadId: "mock_upl_123",
          parts: [
            { partNumber: 1, eTag: "etag-1" },
            { partNumber: 1, eTag: "etag-dup" },
          ],
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          code: "INVALID_PART",
        })
      );
    });

    it("rejects empty parts list", async () => {
      await expect(
        storageService.completeMultipartUpload({
          objectKey: "test/key",
          uploadId: "mock_upl_123",
          parts: [],
        })
      ).rejects.toThrow(StorageError);
    });

    it("rejects empty or missing ETag", async () => {
      await expect(
        storageService.completeMultipartUpload({
          objectKey: "test/key",
          uploadId: "mock_upl_123",
          parts: [{ partNumber: 1, eTag: "   " }],
        })
      ).rejects.toThrow(StorageError);
    });
  });

  describe("abortMultipartUpload", () => {
    it("successfully calls abort command", async () => {
      mockS3Client.send.mockResolvedValueOnce({});

      await expect(
        storageService.abortMultipartUpload({
          objectKey: "test/key",
          uploadId: "mock_upl_123",
        })
      ).resolves.not.toThrow();

      expect(mockS3Client.send).toHaveBeenCalledTimes(1);
    });

    it("maps provider failure into sanitized error", async () => {
      mockS3Client.send.mockRejectedValueOnce({
        name: "ServiceUnavailable",
        $metadata: { httpStatusCode: 503 },
      });

      await expect(
        storageService.abortMultipartUpload({
          objectKey: "test/key",
          uploadId: "mock_upl_123",
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          code: "PROVIDER_UNAVAILABLE",
          isRetryable: true,
        })
      );
    });
  });

  describe("headObject", () => {
    it("returns normalized object metadata when object exists", async () => {
      mockS3Client.send.mockResolvedValueOnce({
        ContentLength: 10485760,
        ETag: '"object-etag-123"',
        ContentType: "application/x-hdf5",
        LastModified: new Date("2026-01-01T12:00:00Z"),
      });

      const res = await storageService.headObject({ objectKey: "test/matrix.h5ad" });

      expect(res).not.toBeNull();
      expect(res?.contentLength).toBe(10485760);
      expect(res?.eTag).toBe("object-etag-123");
      expect(res?.contentType).toBe("application/x-hdf5");
    });

    it("returns null when object does not exist (NotFound or 404)", async () => {
      mockS3Client.send.mockRejectedValueOnce({
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      });

      const res = await storageService.headObject({ objectKey: "missing/file.h5ad" });
      expect(res).toBeNull();
    });

    it("throws sanitized error on non-404 provider errors", async () => {
      mockS3Client.send.mockRejectedValueOnce({
        name: "InvalidAccessKeyId",
        $metadata: { httpStatusCode: 403 },
      });

      await expect(storageService.headObject({ objectKey: "test/file.h5ad" })).rejects.toThrowError(
        expect.objectContaining({
          code: "PROVIDER_AUTH_ERROR",
        })
      );
    });
  });

  describe("createPresignedDownloadUrl", () => {
    it("generates presigned download url with 5-minute default", async () => {
      const url = await storageService.createPresignedDownloadUrl({
        objectKey: "test/matrix.h5ad",
      });

      expect(url).toContain("https://mock-presigned-url.r2.internal/test/matrix.h5ad");
      expect(url).toContain("expiresIn=300");
    });
  });

  describe("sanitizeProviderError", () => {
    it("maps unknown error without metadata into generic PROVIDER_ERROR", () => {
      const err = sanitizeProviderError(new Error("socket hang up"));
      expect(err.code).toBe("PROVIDER_ERROR");
      expect(err.isRetryable).toBe(false);
      expect(err.message).toBe("A storage provider operation failed");
    });
  });
});

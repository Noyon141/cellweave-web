import { describe, it, expect, vi } from "vitest";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  issueCanonicalArtifactPublicationCapabilities,
  assertConditionalPutSignedHeaders,
  redactCapabilityUrl,
  type CanonicalPublicationCapabilityDiagnosticEvent,
} from "@/server/integrations/storage/canonical-publication-capability";
import * as objectKeyModule from "@/server/integrations/storage/object-key";
import { StorageError, STORAGE_DEFAULTS } from "@/server/integrations/storage/storage-types";

describe("Canonical Artifact Publication Capability Issuer (Phase 3 Step H.2)", () => {
  const testClient = new S3Client({
    region: "auto",
    endpoint: "https://test_account_id.r2.cloudflarestorage.com",
    credentials: {
      accessKeyId: "test_access_key_id",
      secretAccessKey: "test_secret_access_key",
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  const testBucket = "cellweave-datasets-test";
  const fixedNow = new Date("2026-10-20T18:00:00.000Z");

  it("1. reuses buildCanonicalDatasetKey and targets exact projectId (never datasetId)", async () => {
    const spy = vi.spyOn(objectKeyModule, "buildCanonicalDatasetKey");

    const organizationId = "org_alpha";
    const projectId = "prj_real_123";
    const datasetVersionId = "dsv_789";
    const datasetId = "ds_wrong_456";

    const capabilities = await issueCanonicalArtifactPublicationCapabilities(
      {
        organizationId,
        projectId,
        datasetVersionId,
      },
      {
        client: testClient,
        bucketName: testBucket,
        now: () => fixedNow,
      }
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      organizationId: "org_alpha",
      projectId: "prj_real_123",
      datasetVersionId: "dsv_789",
    });

    const expectedKeyPath =
      "/org/org_alpha/project/prj_real_123/datasets/dsv_789/canonical/canonical.h5ad";

    const putParsed = new URL(capabilities.putUrl);
    const getParsed = new URL(capabilities.getUrl);

    expect(putParsed.hostname).toBe(`${testBucket}.test_account_id.r2.cloudflarestorage.com`);
    expect(getParsed.hostname).toBe(`${testBucket}.test_account_id.r2.cloudflarestorage.com`);
    expect(putParsed.pathname).toBe(expectedKeyPath);
    expect(getParsed.pathname).toBe(expectedKeyPath);
    expect(putParsed.pathname).toContain("prj_real_123");
    expect(putParsed.pathname).not.toContain(datasetId);
    expect(getParsed.pathname).toContain("prj_real_123");
    expect(getParsed.pathname).not.toContain(datasetId);

    spy.mockRestore();
  });

  it("2. cryptographically binds If-None-Match: * and Content-Type in X-Amz-SignedHeaders on PUT", async () => {
    const capabilities = await issueCanonicalArtifactPublicationCapabilities(
      {
        organizationId: "org_alpha",
        projectId: "prj_real_123",
        datasetVersionId: "dsv_789",
      },
      {
        client: testClient,
        bucketName: testBucket,
        now: () => fixedNow,
      }
    );

    expect(capabilities.requiredPutHeaders).toEqual({
      "If-None-Match": "*",
      "Content-Type": "application/x-hdf5",
    });
    expect(capabilities.requiredGetHeaders).toEqual({});

    const putParsed = new URL(capabilities.putUrl);
    const signedHeaders = (putParsed.searchParams.get("X-Amz-SignedHeaders") ?? "")
      .split(";")
      .map((s) => s.trim().toLowerCase());

    expect(signedHeaders).toContain("if-none-match");
    expect(signedHeaders).toContain("content-type");
    expect(signedHeaders).toContain("host");
    expect(putParsed.searchParams.get("x-id")).toBe("PutObject");
    // Ensure no dummy 0-byte CRC32 query parameter is injected
    expect(putParsed.searchParams.get("x-amz-checksum-crc32")).toBeNull();

    const getParsed = new URL(capabilities.getUrl);
    expect(getParsed.searchParams.get("x-id")).toBe("GetObject");
  });

  it("3. fails closed if a custom/faulty presigner omits if-none-match from X-Amz-SignedHeaders", async () => {
    const unsafePresign = vi
      .fn()
      .mockResolvedValue(
        "https://test_account_id.r2.cloudflarestorage.com/cellweave-datasets-test/key?X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeef"
      );

    await expect(
      issueCanonicalArtifactPublicationCapabilities(
        {
          organizationId: "org_alpha",
          projectId: "prj_real_123",
          datasetVersionId: "dsv_789",
        },
        {
          client: testClient,
          bucketName: testBucket,
          presignFn: unsafePresign,
          now: () => fixedNow,
        }
      )
    ).rejects.toThrow(StorageError);

    expect(() =>
      assertConditionalPutSignedHeaders(
        "https://test_account_id.r2.cloudflarestorage.com/cellweave-datasets-test/key?X-Amz-SignedHeaders=host"
      )
    ).toThrow(StorageError);
  });

  it("4. verifies PUT and GET commands target the exact same Bucket and Key without listing or delete permissions", async () => {
    const capturedCommands: unknown[] = [];
    const customPresign = vi.fn().mockImplementation(async (_client, command, _opts) => {
      capturedCommands.push(command);
      if (command instanceof PutObjectCommand) {
        return `https://test.r2.cloudflarestorage.com/${command.input.Bucket}/${command.input.Key}?X-Amz-SignedHeaders=content-type%3Bhost%3Bif-none-match&X-Amz-Signature=sig_put`;
      }
      if (command instanceof GetObjectCommand) {
        return `https://test.r2.cloudflarestorage.com/${command.input.Bucket}/${command.input.Key}?X-Amz-SignedHeaders=host&X-Amz-Signature=sig_get`;
      }
      throw new Error("Unexpected command");
    });

    await issueCanonicalArtifactPublicationCapabilities(
      {
        organizationId: "org_alpha",
        projectId: "prj_real_123",
        datasetVersionId: "dsv_789",
      },
      {
        client: testClient,
        bucketName: testBucket,
        presignFn: customPresign,
        now: () => fixedNow,
      }
    );

    expect(capturedCommands).toHaveLength(2);
    const [putCmd, getCmd] = capturedCommands as [PutObjectCommand, GetObjectCommand];
    expect(putCmd).toBeInstanceOf(PutObjectCommand);
    expect(getCmd).toBeInstanceOf(GetObjectCommand);
    expect(putCmd.input.Bucket).toBe(testBucket);
    expect(getCmd.input.Bucket).toBe(testBucket);
    expect(putCmd.input.Key).toBe(
      "org/org_alpha/project/prj_real_123/datasets/dsv_789/canonical/canonical.h5ad"
    );
    expect(getCmd.input.Key).toBe(putCmd.input.Key);
    expect(putCmd.input.IfNoneMatch).toBe("*");
    expect(putCmd.input.ContentType).toBe("application/x-hdf5");
  });

  it("5. rejects unsafe identifiers and unexpected input parameters (arbitrary key, bucket, file stream)", async () => {
    for (const badOrg of ["", "org/../evil", "org/slash", "org\\backslash", "org space"]) {
      await expect(
        issueCanonicalArtifactPublicationCapabilities(
          {
            organizationId: badOrg,
            projectId: "prj_123",
            datasetVersionId: "dsv_789",
          },
          { client: testClient, bucketName: testBucket }
        )
      ).rejects.toThrow(StorageError);
    }

    for (const extraProp of [
      "r2Key",
      "canonicalArtifactKey",
      "bucket",
      "fileBytes",
      "canonicalChecksum",
      "sourceChecksum",
    ]) {
      const injectedParams = {
        organizationId: "org_alpha",
        projectId: "prj_real_123",
        datasetVersionId: "dsv_789",
        [extraProp]: "injected",
      } as unknown as Parameters<typeof issueCanonicalArtifactPublicationCapabilities>[0];

      await expect(
        issueCanonicalArtifactPublicationCapabilities(injectedParams, {
          client: testClient,
          bucketName: testBucket,
        })
      ).rejects.toThrow(StorageError);
    }
  });

  it("6. leaks no organizationId, projectId, bucket, r2Key, or credentials in returned contract fields", async () => {
    const capabilities = await issueCanonicalArtifactPublicationCapabilities(
      {
        organizationId: "org_alpha",
        projectId: "prj_real_123",
        datasetVersionId: "dsv_789",
      },
      {
        client: testClient,
        bucketName: testBucket,
        now: () => fixedNow,
      }
    );

    expect(Object.keys(capabilities).sort()).toEqual(
      [
        "datasetVersionId",
        "expiresAt",
        "getUrl",
        "putUrl",
        "requiredGetHeaders",
        "requiredPutHeaders",
      ].sort()
    );
    expect("organizationId" in capabilities).toBe(false);
    expect("projectId" in capabilities).toBe(false);
    expect("bucket" in capabilities).toBe(false);
    expect("r2Key" in capabilities).toBe(false);
    expect("canonicalArtifactKey" in capabilities).toBe(false);
    expect("accessKeyId" in capabilities).toBe(false);
    expect("secretAccessKey" in capabilities).toBe(false);
  });

  it("7. computes exact UTC expiresAt matching capability expiration window and rejects invalid durations", async () => {
    const capabilities = await issueCanonicalArtifactPublicationCapabilities(
      {
        organizationId: "org_alpha",
        projectId: "prj_real_123",
        datasetVersionId: "dsv_789",
        expiresInSeconds: 600,
      },
      {
        client: testClient,
        bucketName: testBucket,
        now: () => fixedNow,
      }
    );

    expect(capabilities.expiresAt).toBe("2026-10-20T18:10:00.000Z");
    const putParsed = new URL(capabilities.putUrl);
    const getParsed = new URL(capabilities.getUrl);
    expect(putParsed.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(getParsed.searchParams.get("X-Amz-Expires")).toBe("600");

    // Reject 0, negative, or excessive duration
    for (const invalidDuration of [
      0,
      -60,
      1.5,
      STORAGE_DEFAULTS.MAX_CANONICAL_PUBLICATION_CAPABILITY_EXPIRES_SECONDS + 1,
    ]) {
      await expect(
        issueCanonicalArtifactPublicationCapabilities(
          {
            organizationId: "org_alpha",
            projectId: "prj_real_123",
            datasetVersionId: "dsv_789",
            expiresInSeconds: invalidDuration,
          },
          { client: testClient, bucketName: testBucket }
        )
      ).rejects.toThrow(StorageError);
    }
  });

  it("8. never emits full putUrl, getUrl, or signature query strings in diagnostic logs or redaction helper", async () => {
    const events: CanonicalPublicationCapabilityDiagnosticEvent[] = [];
    const capabilities = await issueCanonicalArtifactPublicationCapabilities(
      {
        organizationId: "org_alpha",
        projectId: "prj_real_123",
        datasetVersionId: "dsv_789",
      },
      {
        client: testClient,
        bucketName: testBucket,
        now: () => fixedNow,
        diagnosticLogger: (evt) => events.push(evt),
      }
    );

    expect(events).toHaveLength(1);
    const serializedLog = JSON.stringify(events[0]);
    expect(serializedLog).toContain("dsv_789");
    expect(serializedLog).not.toContain("X-Amz-Signature");
    expect(serializedLog).not.toContain("X-Amz-Credential");
    expect(serializedLog).not.toContain(capabilities.putUrl);
    expect(serializedLog).not.toContain(capabilities.getUrl);
    expect(serializedLog).not.toContain("test_secret_access_key");

    const redacted = redactCapabilityUrl(capabilities.putUrl);
    expect(redacted).not.toContain("X-Amz-Signature");
    expect(redacted).toContain("<REDACTED_CAPABILITY_SIGNATURE>");
  });
});

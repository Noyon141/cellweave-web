import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "@/server/database/schema";
import { randomUUID } from "node:crypto";
import { UploadSessionService } from "@/server/services/upload-session-service";
import { ProjectPermissionService } from "@/server/services/project-permission-service";
import { AuditService } from "@/server/services/audit-service";
import { R2StorageService } from "@/server/integrations/storage/r2-storage-service";
import { getR2Client } from "@/server/integrations/storage/r2-client";
import {
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
} from "@aws-sdk/client-s3";
import type { TenantContext } from "@/types";
import { ConflictError } from "@/server/authorization/errors";

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(".env.local");
  } catch {}
}

describe("Phase 2 Step H.5: Live DEV Neon & R2 Upload Identity & Initiation Hardening", () => {
  let ownerPool: Pool;
  let runtimePool: Pool;
  let uploadService: UploadSessionService;
  let storageService: R2StorageService;
  const accountId = process.env.R2_ACCOUNT_ID || "81fafb4f3e16f76292b4458bdab4f180";
  const bucketName = process.env.R2_BUCKET_NAME || "cellweave-artifacts-dev";
  const s3Client = getR2Client({
    accountId,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucketName,
  });

  const testRunId = randomUUID().replace(/-/g, "").slice(0, 12);
  const orgAId = `h5_org_${testRunId}`;
  const userIdA = `h5_usr_${testRunId}`;
  const projAId = `h5_prj_${testRunId}`;
  const dsAId = `ds_${randomUUID()}`;
  const dsvAId = `dsv_${randomUUID()}`;

  const tenantCtxA: TenantContext = {
    organizationId: orgAId,
    userId: userIdA,
    role: "owner",
  };

  const createdR2Keys: string[] = [];

  beforeAll(async () => {
    if (bucketName !== "cellweave-artifacts-dev") {
      throw new Error(
        `Safety assertion failed: bucket is '${bucketName}', expected 'cellweave-artifacts-dev'`
      );
    }

    const apiKey = process.env.NEON_API_KEY;
    if (!apiKey) throw new Error("NEON_API_KEY is required for live DEV tests");

    const ownerRes = await fetch(
      "https://console.neon.tech/api/v2/projects/sparkling-dust-06267724/connection_uri?branch_id=br-floral-moon-b50d1sje&database_name=neondb&role_name=neondb_owner&pooled=false",
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } }
    );
    const ownerData = await ownerRes.json();
    ownerPool = new Pool({ connectionString: ownerData.uri });

    runtimePool = new Pool({ connectionString: process.env.DATABASE_URL });
    const runtimeDb = drizzle(runtimePool, { schema });

    const auditService = new AuditService({ dbClient: runtimeDb });
    const permissionService = new ProjectPermissionService({
      dbClient: runtimeDb,
      auditService,
    });
    storageService = new R2StorageService(s3Client, bucketName);
    uploadService = new UploadSessionService({
      dbClient: runtimeDb,
      auditService,
      permissionService,
      storageService,
    });

    // Seed test fixtures
    await ownerPool.query(
      `INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at) VALUES ($1, 'User H5', '${userIdA}@test.cellweave.internal', true, null, NOW(), NOW())`,
      [userIdA]
    );

    await ownerPool.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Org H5 Hardening', $1, NOW())`,
      [orgAId]
    );

    await ownerPool.query(
      `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, 'owner', NOW())`,
      [`mem_${randomUUID()}`, orgAId, userIdA]
    );

    await ownerPool.query(
      `INSERT INTO projects (id, organization_id, name, created_by, created_at, updated_at) VALUES ($1, $2, 'Hardening Project', $3, NOW(), NOW())`,
      [projAId, orgAId, userIdA]
    );

    await ownerPool.query(
      `INSERT INTO datasets (id, organization_id, project_id, name, created_by, created_at) VALUES ($1, $2, $3, 'H5 Hardening Dataset', $4, NOW())`,
      [dsAId, orgAId, projAId, userIdA]
    );

    await ownerPool.query(
      `INSERT INTO dataset_versions (id, organization_id, dataset_id, version_number, source_format, created_at) VALUES ($1, $2, $3, 1, '10x_mtx', NOW())`,
      [dsvAId, orgAId, dsAId]
    );
  });

  afterAll(async () => {
    for (const key of createdR2Keys) {
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
      } catch {}
    }

    if (ownerPool) {
      await ownerPool.query(`DELETE FROM organization WHERE id = $1`, [orgAId]);
      await ownerPool.query(`DELETE FROM "user" WHERE id = $1`, [userIdA]);
      await ownerPool.end();
    }
    if (runtimePool) {
      await runtimePool.end();
    }
  });

  it("1. proves concurrent initiation race: 5 simultaneous requests for identical object yield exactly 1 winner and 4 ConflictErrors with no orphaned R2 uploads", async () => {
    const fileName = "concurrent_target.h5ad";
    const expectedSize = 10 * 1024 * 1024;

    // Fire 5 identical requests concurrently
    const promises = Array.from({ length: 5 }, () =>
      uploadService
        .initiateUpload(tenantCtxA, {
          datasetVersionId: dsvAId,
          fileName,
          expectedSize,
          contentType: "application/octet-stream",
        })
        .then(
          (session) => ({ success: true as const, session }),
          (error) => ({ success: false as const, error })
        )
    );

    const results = await Promise.all(promises);

    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    // Exactly 1 must succeed
    expect(successes).toHaveLength(1);
    // Exactly 4 must fail
    expect(failures).toHaveLength(4);

    const winningSession = successes[0]!.session;
    createdR2Keys.push(winningSession.r2Key);

    // All failures must be ConflictError
    for (const f of failures) {
      expect(f.error).toBeInstanceOf(ConflictError);
      expect((f.error as ConflictError).message).toMatch(
        /An active upload (already exists|session already exists)/
      );
    }

    // Verify DB has only 1 active session for this key
    const { rows: activeRows } = await runtimePool.query(
      `SELECT id, status, r2_key FROM upload_sessions WHERE organization_id = $1 AND dataset_version_id = $2 AND r2_key = $3`,
      [orgAId, dsvAId, winningSession.r2Key]
    );
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].id).toBe(winningSession.id);

    // Check R2 for orphaned multipart uploads: exactly 1 upload exists on this object key in R2
    const listUploadsRes = await s3Client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucketName,
        Prefix: winningSession.r2Key,
      })
    );
    const activeUploadsOnKey = (listUploadsRes.Uploads || []).filter(
      (u) => u.Key === winningSession.r2Key
    );
    expect(activeUploadsOnKey).toHaveLength(1);

    // Verify the winning session's multipart upload in R2 is functional
    const parts = await storageService.listMultipartParts({
      objectKey: winningSession.r2Key,
      uploadId: winningSession.r2UploadId,
    });
    expect(parts).toEqual([]);

    // Clean up winner session
    await uploadService.abortUpload(tenantCtxA, winningSession.id);
  }, 45000);

  it("2. proves terminal session retry: after an upload is ABORTED, a new initiation for the same file succeeds", async () => {
    const fileName = "retry_target.h5ad";
    const expectedSize = 10 * 1024 * 1024;

    // First session
    const firstSession = await uploadService.initiateUpload(tenantCtxA, {
      datasetVersionId: dsvAId,
      fileName,
      expectedSize,
      contentType: "application/octet-stream",
    });
    createdR2Keys.push(firstSession.r2Key);

    // Abort it -> enters terminal state ABORTED
    const aborted = await uploadService.abortUpload(tenantCtxA, firstSession.id);
    expect(aborted.status).toBe("ABORTED");

    // Second session for identical file must now succeed without 409 Conflict
    const secondSession = await uploadService.initiateUpload(tenantCtxA, {
      datasetVersionId: dsvAId,
      fileName,
      expectedSize,
      contentType: "application/octet-stream",
    });
    expect(secondSession.id).not.toBe(firstSession.id);
    expect(secondSession.status).toBe("CREATED");
    expect(secondSession.r2Key).toBe(firstSession.r2Key);

    // Clean up second session
    await uploadService.abortUpload(tenantCtxA, secondSession.id);
  }, 30000);

  it("3. proves multi-file dataset support: distinct files on the same dataset version initiate independently without conflict", async () => {
    const files = ["matrix.mtx.gz", "barcodes.tsv.gz", "features.tsv.gz"];

    const sessions = await Promise.all(
      files.map((file) =>
        uploadService.initiateUpload(tenantCtxA, {
          datasetVersionId: dsvAId,
          fileName: file,
          expectedSize: 5 * 1024 * 1024,
          contentType: "application/gzip",
        })
      )
    );

    expect(sessions).toHaveLength(3);
    const keys = sessions.map((s) => s.r2Key);
    // Keys must all be distinct
    expect(new Set(keys).size).toBe(3);

    for (const s of sessions) {
      createdR2Keys.push(s.r2Key);
      expect(s.status).toBe("CREATED");
      await uploadService.abortUpload(tenantCtxA, s.id);
    }
  }, 30000);

  it("4. proves verified object immutability: once completed and verified, re-upload is rejected before R2 initiation", async () => {
    const fileName = "immutable_source.h5ad";
    const fileSize = 5 * 1024 * 1024; // 5 MiB (single part for fast completion)

    const session = await uploadService.initiateUpload(tenantCtxA, {
      datasetVersionId: dsvAId,
      fileName,
      expectedSize: fileSize,
      contentType: "application/octet-stream",
    });
    createdR2Keys.push(session.r2Key);

    // Generate part URL and upload buffer directly
    const partUrl = await uploadService.createPartUploadUrls(tenantCtxA, {
      sessionId: session.id,
      partNumbers: [1],
    });

    expect(partUrl[0]).toBeDefined();
    const firstPart = partUrl[0]!;

    const payload = Buffer.alloc(fileSize, 0x42);
    const putRes = await fetch(firstPart.presignedUrl, {
      method: "PUT",
      body: payload,
    });
    expect(putRes.status).toBe(200);

    // Complete upload -> writes dataset_files row and sets status VERIFIED
    const completed = await uploadService.completeUpload(tenantCtxA, session.id);
    expect(completed.session.status).toBe("VERIFIED");

    // Verify dataset_files has the row
    const { rows: fileRows } = await runtimePool.query(
      `SELECT id, dataset_version_id, r2_key FROM dataset_files WHERE dataset_version_id = $1 AND r2_key = $2`,
      [dsvAId, session.r2Key]
    );
    expect(fileRows).toHaveLength(1);

    // Now attempt to initiate upload again for the exact same fileName
    await expect(
      uploadService.initiateUpload(tenantCtxA, {
        datasetVersionId: dsvAId,
        fileName,
        expectedSize: fileSize,
        contentType: "application/octet-stream",
      })
    ).rejects.toThrow(ConflictError);

    await expect(
      uploadService.initiateUpload(tenantCtxA, {
        datasetVersionId: dsvAId,
        fileName,
        expectedSize: fileSize,
        contentType: "application/octet-stream",
      })
    ).rejects.toThrow(
      "An immutable verified file already exists for this dataset version and file key"
    );

    // Verify no new multipart upload was initiated in R2
    const listUploadsRes = await s3Client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucketName,
        Prefix: session.r2Key,
      })
    );
    expect(listUploadsRes.Uploads || []).toHaveLength(0);
  }, 45000);
});

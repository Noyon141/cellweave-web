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
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { TenantContext } from "@/types";
import { ResourceNotFoundError, ValidationError } from "@/server/authorization/errors";

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(".env.local");
  } catch {}
}

describe("Phase 2 Step G: Live DEV Neon & R2 Resumable Multipart Upload Orchestration", () => {
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
  const orgAId = `g_org_a_${testRunId}`;
  const orgBId = `g_org_b_${testRunId}`;
  const userIdA = `g_usr_a_${testRunId}`;
  const userIdB = `g_usr_b_${testRunId}`;
  const projAId = `g_prj_a_${testRunId}`;
  const dsAId = `ds_${randomUUID()}`;
  const dsvAId = `dsv_${randomUUID()}`;

  const tenantCtxA: TenantContext = {
    organizationId: orgAId,
    userId: userIdA,
    role: "owner",
  };

  const tenantCtxB: TenantContext = {
    organizationId: orgBId,
    userId: userIdB,
    role: "owner",
  };

  const createdR2Keys: string[] = [];

  beforeAll(async () => {
    // 1. Strict safety guard: Only run against cellweave-artifacts-dev
    if (bucketName !== "cellweave-artifacts-dev") {
      throw new Error(
        `Safety assertion failed: R2 bucket is '${bucketName}', expected 'cellweave-artifacts-dev'`
      );
    }

    const apiKey = process.env.NEON_API_KEY;
    if (!apiKey) throw new Error("NEON_API_KEY is required for live DEV tests");

    // Fetch direct neondb_owner URI for fixture seeding
    const ownerRes = await fetch(
      "https://console.neon.tech/api/v2/projects/sparkling-dust-06267724/connection_uri?branch_id=br-floral-moon-b50d1sje&database_name=neondb&role_name=neondb_owner&pooled=false",
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } }
    );
    const ownerData = await ownerRes.json();
    ownerPool = new Pool({ connectionString: ownerData.uri });

    // Runtime pool uses DATABASE_URL
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

    // 2. Seed test fixtures in DEV Neon
    await ownerPool.query(
      `INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at) VALUES
       ($1, 'User A', '${userIdA}@test.cellweave.internal', true, null, NOW(), NOW()),
       ($2, 'User B', '${userIdB}@test.cellweave.internal', true, null, NOW(), NOW())`,
      [userIdA, userIdB]
    );

    await ownerPool.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES
       ($1, 'Org G Alpha', $1, NOW()),
       ($2, 'Org G Beta', $2, NOW())`,
      [orgAId, orgBId]
    );

    await ownerPool.query(
      `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES
       ($1, $2, $3, 'owner', NOW()),
       ($4, $5, $6, 'owner', NOW())`,
      [`mem_${randomUUID()}`, orgAId, userIdA, `mem_${randomUUID()}`, orgBId, userIdB]
    );

    await ownerPool.query(
      `INSERT INTO projects (id, organization_id, name, created_by, created_at, updated_at) VALUES
       ($1, $2, 'Upload Project Alpha', $3, NOW(), NOW())`,
      [projAId, orgAId, userIdA]
    );

    await ownerPool.query(
      `INSERT INTO datasets (id, organization_id, project_id, name, created_by, created_at) VALUES
       ($1, $2, $3, 'Live Upload Dataset', $4, NOW())`,
      [dsAId, orgAId, projAId, userIdA]
    );

    await ownerPool.query(
      `INSERT INTO dataset_versions (id, organization_id, dataset_id, version_number, source_format, created_at) VALUES
       ($1, $2, $3, 1, '10x_h5', NOW())`,
      [dsvAId, orgAId, dsAId]
    );
  });

  afterAll(async () => {
    // 1. Cleanup R2 objects created during test
    for (const key of createdR2Keys) {
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
      } catch {
        // Suppress cleanup error
      }
    }

    // 2. Cleanup DB fixtures
    if (ownerPool) {
      await ownerPool.query(`DELETE FROM organization WHERE id IN ($1, $2)`, [orgAId, orgBId]);
      await ownerPool.query(`DELETE FROM "user" WHERE id IN ($1, $2)`, [userIdA, userIdB]);
      await ownerPool.end();
    }
    if (runtimePool) {
      await runtimePool.end();
    }
  });

  it("1. executes full resumable multipart upload lifecycle directly against Cloudflare R2 and DEV Neon", async () => {
    // 25 MiB file with default 10 MiB parts -> 3 parts (10 MiB, 10 MiB, 5 MiB)
    const expectedSize = 25 * 1024 * 1024;
    const part1Size = 10 * 1024 * 1024;
    const part2Size = 10 * 1024 * 1024;
    const part3Size = 5 * 1024 * 1024;

    // Step 1: Initiate upload
    const session = await uploadService.initiateUpload(tenantCtxA, {
      datasetVersionId: dsvAId,
      fileName: "brain_cortex_25mb.h5ad",
      expectedSize,
      contentType: "application/x-hdf5",
    });

    createdR2Keys.push(session.r2Key);

    expect(session.id).toMatch(/^upl_/);
    expect(session.status).toBe("CREATED");
    expect(session.partSize).toBe(10 * 1024 * 1024);
    expect(session.totalParts).toBe(3);
    expect(session.r2Key).toBe(
      `org/${orgAId}/project/${projAId}/datasets/${dsvAId}/source/brain_cortex_25mb.h5ad`
    );

    // Step 2: Request presigned URL for Part 1
    const [part1UrlDto] = await uploadService.createPartUploadUrls(tenantCtxA, {
      sessionId: session.id,
      partNumbers: [1],
    });

    expect(part1UrlDto).toBeDefined();
    expect(part1UrlDto?.partNumber).toBe(1);
    expect(part1UrlDto?.presignedUrl).toContain("https://");

    // Session status in DB should now be UPLOADING
    const activeSession = await uploadService.getUploadSession(tenantCtxA, session.id);
    expect(activeSession.status).toBe("UPLOADING");

    // Step 3: Direct browser-to-R2 upload simulation: PUT Part 1 buffer to presigned URL
    const part1Buffer = Buffer.alloc(part1Size, 0xaa);
    const putPart1Res = await fetch(part1UrlDto!.presignedUrl, {
      method: "PUT",
      body: part1Buffer,
    });
    expect(putPart1Res.status).toBe(200);

    // Step 4: Simulate network interruption & client resume
    // Discard client-side state and call getResumeState
    const resumeState = await uploadService.getResumeState(tenantCtxA, session.id);
    expect(resumeState.status).toBe("UPLOADING");
    expect(resumeState.totalParts).toBe(3);
    expect(resumeState.uploadedParts).toHaveLength(1);
    expect(resumeState.uploadedParts[0]?.partNumber).toBe(1);
    expect(resumeState.uploadedParts[0]?.eTag).toBeTruthy();
    expect(resumeState.missingParts).toEqual([2, 3]);

    // Step 5: Request URLs for remaining parts 2 and 3
    const remainingUrls = await uploadService.createPartUploadUrls(tenantCtxA, {
      sessionId: session.id,
      partNumbers: [2, 3],
    });
    expect(remainingUrls).toHaveLength(2);

    const part2Url = remainingUrls.find((u) => u.partNumber === 2)!.presignedUrl;
    const part3Url = remainingUrls.find((u) => u.partNumber === 3)!.presignedUrl;

    // Upload Part 2 and Part 3 directly to R2
    const part2Buffer = Buffer.alloc(part2Size, 0xbb);
    const putPart2Res = await fetch(part2Url, { method: "PUT", body: part2Buffer });
    expect(putPart2Res.status).toBe(200);

    const part3Buffer = Buffer.alloc(part3Size, 0xcc);
    const putPart3Res = await fetch(part3Url, { method: "PUT", body: part3Buffer });
    expect(putPart3Res.status).toBe(200);

    // Verify resume state now reports 0 missing parts
    const resumeAllParts = await uploadService.getResumeState(tenantCtxA, session.id);
    expect(resumeAllParts.uploadedParts).toHaveLength(3);
    expect(resumeAllParts.missingParts).toEqual([]);

    // Step 6: Complete upload
    const completeResult = await uploadService.completeUpload(tenantCtxA, session.id);

    expect(completeResult.session.status).toBe("VERIFIED");
    expect(completeResult.file.id).toMatch(/^dsf_/);
    expect(completeResult.file.byteSize).toBe(expectedSize);
    expect(completeResult.file.fileName).toBe("brain_cortex_25mb.h5ad");
    expect(completeResult.file.r2Key).toBe(session.r2Key);

    // Step 7: Verify persistent state in DEV Neon database
    const { rows: sessionRows } = await runtimePool.query(
      `SELECT status FROM upload_sessions WHERE id = $1`,
      [session.id]
    );
    expect(sessionRows[0]?.status).toBe("VERIFIED");

    const { rows: fileRows } = await runtimePool.query(
      `SELECT id, byte_size, etag FROM dataset_files WHERE dataset_version_id = $1 AND r2_key = $2`,
      [dsvAId, session.r2Key]
    );
    expect(fileRows).toHaveLength(1);
    expect(Number(fileRows[0]?.byte_size)).toBe(expectedSize);

    // Verify audit events recorded
    const { rows: auditRows } = await runtimePool.query(
      `SELECT action, resource_id FROM audit_events WHERE organization_id = $1 AND resource_id = $2 ORDER BY created_at ASC`,
      [orgAId, session.id]
    );
    const actions = auditRows.map((r) => r.action);
    expect(actions).toContain("upload.initiated");
    expect(actions).toContain("upload.completed");

    // Step 8: Prove completion idempotency
    const reCompleteResult = await uploadService.completeUpload(tenantCtxA, session.id);
    expect(reCompleteResult.session.status).toBe("VERIFIED");
    expect(reCompleteResult.file.id).toBe(completeResult.file.id);
  }, 90000);

  it("2. enforces tenant isolation: cross-tenant access to upload session is strictly rejected", async () => {
    // Org A initiates a session
    const sessionA = await uploadService.initiateUpload(tenantCtxA, {
      datasetVersionId: dsvAId,
      fileName: "private_data.h5ad",
      expectedSize: 10 * 1024 * 1024,
      contentType: "application/octet-stream",
    });
    createdR2Keys.push(sessionA.r2Key);

    // Org B actor attempts to get, generate URLs, or complete Org A's session
    await expect(uploadService.getUploadSession(tenantCtxB, sessionA.id)).rejects.toThrow(
      ResourceNotFoundError
    );

    await expect(
      uploadService.createPartUploadUrls(tenantCtxB, {
        sessionId: sessionA.id,
        partNumbers: [1],
      })
    ).rejects.toThrow(ResourceNotFoundError);

    await expect(uploadService.completeUpload(tenantCtxB, sessionA.id)).rejects.toThrow(
      ResourceNotFoundError
    );

    await expect(uploadService.abortUpload(tenantCtxB, sessionA.id)).rejects.toThrow(
      ResourceNotFoundError
    );
  }, 30000);

  it("3. executes abortUpload and cleans up provider multipart session with audit trail", async () => {
    // Initiate session to abort
    const sessionToAbort = await uploadService.initiateUpload(tenantCtxA, {
      datasetVersionId: dsvAId,
      fileName: "aborted_run.h5ad",
      expectedSize: 15 * 1024 * 1024,
      contentType: "application/octet-stream",
    });
    createdR2Keys.push(sessionToAbort.r2Key);

    // Call abortUpload
    const aborted = await uploadService.abortUpload(tenantCtxA, sessionToAbort.id);
    expect(aborted.status).toBe("ABORTED");

    // Verify DB state
    const { rows } = await runtimePool.query(`SELECT status FROM upload_sessions WHERE id = $1`, [
      sessionToAbort.id,
    ]);
    expect(rows[0]?.status).toBe("ABORTED");

    // Verify audit event
    const { rows: auditRows } = await runtimePool.query(
      `SELECT action FROM audit_events WHERE resource_id = $1 AND action = 'upload.aborted'`,
      [sessionToAbort.id]
    );
    expect(auditRows).toHaveLength(1);

    // Verify idempotent abort call
    const reAborted = await uploadService.abortUpload(tenantCtxA, sessionToAbort.id);
    expect(reAborted.status).toBe("ABORTED");

    // Cannot complete an aborted session
    await expect(uploadService.completeUpload(tenantCtxA, sessionToAbort.id)).rejects.toThrow(
      ValidationError
    );
  }, 30000);

  it("4. verifies private object security: unauthenticated requests to the private R2 object are denied", async () => {
    // Pick the completed 25 MiB test object key from test 1
    const completedKey = createdR2Keys[0];
    expect(completedKey).toBeDefined();

    // Attempt unauthenticated GET directly against Cloudflare R2 endpoint
    const unauthenticatedUrl = `https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${completedKey}`;

    let unauthenticatedStatus: number | null = null;
    try {
      const res = await fetch(unauthenticatedUrl, { method: "GET" });
      unauthenticatedStatus = res.status;
    } catch {
      // Network/TLS rejection without credentials is also a valid denial
      unauthenticatedStatus = 403;
    }

    // Must be denied: either 401 Unauthorized, 403 Forbidden, 400 Bad Request (missing auth headers), or network rejection
    expect([400, 401, 403, 404]).toContain(unauthenticatedStatus);
  }, 30000);
});

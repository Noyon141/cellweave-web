import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "@/server/database/schema";
import { randomUUID } from "node:crypto";
import { DatasetService } from "@/server/services/dataset-service";
import { ProjectPermissionService } from "@/server/services/project-permission-service";
import { AuditService } from "@/server/services/audit-service";
import type { TenantContext } from "@/types";

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(".env.local");
  } catch {}
}

describe("Phase 2 Step F: Live DEV Neon Dataset Version Concurrency Verification", () => {
  let ownerPool: Pool;
  let runtimePool: Pool;
  let datasetService: DatasetService;

  const testRunId = randomUUID().replace(/-/g, "").slice(0, 12);
  const orgAId = `cf_org_a_${testRunId}`;
  const userIdA = `cf_usr_a_${testRunId}`;
  const projAId = `cf_prj_a_${testRunId}`;
  const ds1Id = `ds_${randomUUID()}`;
  const ds2Id = `ds_${randomUUID()}`;

  const tenantCtx: TenantContext = {
    organizationId: orgAId,
    userId: userIdA,
    role: "owner",
  };

  beforeAll(async () => {
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
    datasetService = new DatasetService({
      dbClient: runtimeDb,
      auditService,
      permissionService,
    });

    // Seed test fixtures
    await ownerPool.query(
      `INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [userIdA, "User Concurrency", `${userIdA}@test.cellweave.internal`, true, null]
    );

    await ownerPool.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $2, $3, NOW())`,
      [orgAId, "Org Concurrency", orgAId]
    );

    await ownerPool.query(
      `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, $4, NOW())`,
      [`mem_${randomUUID()}`, orgAId, userIdA, "owner"]
    );

    await ownerPool.query(
      `INSERT INTO projects (id, organization_id, name, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [projAId, orgAId, "Concurrency Project", userIdA]
    );

    await ownerPool.query(
      `INSERT INTO datasets (id, organization_id, project_id, name, created_by, created_at) VALUES ($1, $2, $3, $4, $5, NOW()), ($6, $7, $8, $9, $10, NOW())`,
      [ds1Id, orgAId, projAId, "Dataset 1", userIdA, ds2Id, orgAId, projAId, "Dataset 2", userIdA]
    );
  });

  afterAll(async () => {
    if (ownerPool) {
      await ownerPool.query(`DELETE FROM organization WHERE id = $1`, [orgAId]);
      await ownerPool.query(`DELETE FROM "user" WHERE id = $1`, [userIdA]);
      await ownerPool.end();
    }
    if (runtimePool) {
      await runtimePool.end();
    }
  });

  it("1. proves concurrent createDatasetVersion calls on a single dataset allocate sequential versions without collision", async () => {
    const concurrencyFactor = 5;
    const versionInputs = Array.from({ length: concurrencyFactor }, (_, idx) => ({
      sourceFormat: "10x_h5",
      organism: `Homo sapiens run ${idx}`,
    }));

    // Fire all version creation promises concurrently
    const results = await Promise.all(
      versionInputs.map((input) => datasetService.createDatasetVersion(tenantCtx, ds1Id, input))
    );

    expect(results).toHaveLength(concurrencyFactor);

    // Extract allocated version numbers
    const allocatedNumbers = results.map((r) => r.versionNumber).sort((a, b) => a - b);

    // Expect strictly [1, 2, 3, 4, 5]
    expect(allocatedNumbers).toEqual([1, 2, 3, 4, 5]);

    // Verify in database that exactly 5 records exist
    const { rows } = await runtimePool.query(
      `SELECT version_number FROM dataset_versions WHERE dataset_id = $1 ORDER BY version_number ASC`,
      [ds1Id]
    );
    expect(rows.map((r) => r.version_number)).toEqual([1, 2, 3, 4, 5]);
  }, 30000);

  it("2. proves concurrent createDatasetVersion calls across different datasets execute without mutual contention", async () => {
    // Run concurrent version creations on ds1 and ds2 simultaneously
    const [dsv1, dsv2] = await Promise.all([
      datasetService.createDatasetVersion(tenantCtx, ds1Id, { sourceFormat: "10x_mtx" }),
      datasetService.createDatasetVersion(tenantCtx, ds2Id, { sourceFormat: "10x_mtx" }),
    ]);

    // ds1 should now be at version 6
    expect(dsv1.versionNumber).toBe(6);
    // ds2 should be at version 1 (isolated from ds1)
    expect(dsv2.versionNumber).toBe(1);
  }, 30000);
});

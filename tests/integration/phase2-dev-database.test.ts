import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(".env.local");
  } catch {}
}

describe(
  "Phase 2 Step D2: Live DEV Neon Constraints & Least-Privilege Verification",
  { timeout: 30000 },
  () => {
    let ownerPool: Pool;
    let runtimePool: Pool;

    const testRunId = randomUUID().replace(/-/g, "").slice(0, 12);
    const orgAId = `d2_org_a_${testRunId}`;
    const orgBId = `d2_org_b_${testRunId}`;
    const userIdA = `d2_usr_a_${testRunId}`;
    const projAId = `d2_prj_a_${testRunId}`;
    const projBId = `d2_prj_b_${testRunId}`;

    const expAId = `exp_${randomUUID()}`;
    const sampleAId = `smp_${randomUUID()}`;
    const dsAId = `ds_${randomUUID()}`;
    const dsvAId = `dsv_${randomUUID()}`;
    const dsfAId = `dsf_${randomUUID()}`;
    const uplAId = `upl_${randomUUID()}`;

    beforeAll(async () => {
      const apiKey = process.env.NEON_API_KEY;
      if (!apiKey) throw new Error("NEON_API_KEY is required for live tests");

      // Fetch direct neondb_owner URI
      const ownerRes = await fetch(
        "https://console.neon.tech/api/v2/projects/sparkling-dust-06267724/connection_uri?branch_id=br-floral-moon-b50d1sje&database_name=neondb&role_name=neondb_owner&pooled=false",
        { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } }
      );
      const ownerData = await ownerRes.json();
      ownerPool = new Pool({ connectionString: ownerData.uri });

      // Runtime connection uses DATABASE_URL from .env.local
      runtimePool = new Pool({ connectionString: process.env.DATABASE_URL });

      // Seed baseline tenant fixtures using owner
      await ownerPool.query(
        `INSERT INTO "user" (id, name, email, email_verified, image, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
        [userIdA, "User D2", `${userIdA}@test.cellweave.internal`, true, null]
      );

      await ownerPool.query(
        `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $2, $3, NOW()), ($4, $5, $6, NOW())`,
        [orgAId, "Org A", orgAId, orgBId, "Org B", orgBId]
      );

      await ownerPool.query(
        `INSERT INTO projects (id, organization_id, name, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW()), ($5, $6, $7, $8, NOW(), NOW())`,
        [projAId, orgAId, "Project A", userIdA, projBId, orgBId, "Project B", userIdA]
      );
    });

    afterAll(async () => {
      if (ownerPool) {
        await ownerPool.query(`
        DELETE FROM upload_sessions WHERE organization_id IN ('${orgAId}', '${orgBId}');
        DELETE FROM dataset_files WHERE organization_id IN ('${orgAId}', '${orgBId}');
        DELETE FROM dataset_versions WHERE organization_id IN ('${orgAId}', '${orgBId}');
        DELETE FROM datasets WHERE organization_id IN ('${orgAId}', '${orgBId}');
        DELETE FROM samples WHERE organization_id IN ('${orgAId}', '${orgBId}');
        DELETE FROM experiments WHERE organization_id IN ('${orgAId}', '${orgBId}');
        DELETE FROM projects WHERE organization_id IN ('${orgAId}', '${orgBId}');
        DELETE FROM organization WHERE id IN ('${orgAId}', '${orgBId}');
        DELETE FROM "user" WHERE id = '${userIdA}';
      `);
        await ownerPool.end();
      }
      if (runtimePool) {
        await runtimePool.end();
      }
    });

    describe("Section 17: Live Constraint Verification", () => {
      it("A. rejects cross-tenant experiment -> project link", async () => {
        // exp linked to projAId (in orgA) but with organization_id = orgBId
        await expect(
          ownerPool.query(`
          INSERT INTO experiments (id, organization_id, project_id, name, created_by, created_at)
          VALUES ('${expAId}', '${orgBId}', '${projAId}', 'Cross Exp', '${userIdA}', NOW());
        `)
        ).rejects.toThrow(/violates foreign key constraint "experiments_project_org_fk"/);
      });

      it("B. rejects cross-tenant sample -> experiment link", async () => {
        // First insert valid experiment in orgA
        await ownerPool.query(`
        INSERT INTO experiments (id, organization_id, project_id, name, created_by, created_at)
        VALUES ('${expAId}', '${orgAId}', '${projAId}', 'Valid Exp A', '${userIdA}', NOW());
      `);

        // Try inserting sample linked to expAId (in orgA) but with organization_id = orgBId
        await expect(
          ownerPool.query(`
          INSERT INTO samples (id, organization_id, experiment_id, sample_key, metadata_json)
          VALUES ('${sampleAId}', '${orgBId}', '${expAId}', 'sample_01', '{}'::jsonb);
        `)
        ).rejects.toThrow(/violates foreign key constraint "samples_experiment_org_fk"/);
      });

      it("C. rejects cross-tenant dataset -> project link", async () => {
        await expect(
          ownerPool.query(`
          INSERT INTO datasets (id, organization_id, project_id, name, created_by, created_at)
          VALUES ('${dsAId}', '${orgBId}', '${projAId}', 'Cross Dataset', '${userIdA}', NOW());
        `)
        ).rejects.toThrow(/violates foreign key constraint "datasets_project_org_fk"/);
      });

      it("D. rejects cross-tenant dataset_version -> dataset link", async () => {
        // Insert valid dataset in orgA
        await ownerPool.query(`
        INSERT INTO datasets (id, organization_id, project_id, name, created_by, created_at)
        VALUES ('${dsAId}', '${orgAId}', '${projAId}', 'Valid Dataset A', '${userIdA}', NOW());
      `);

        // Try inserting version linked to dsAId (in orgA) but with organization_id = orgBId
        await expect(
          ownerPool.query(`
          INSERT INTO dataset_versions (id, organization_id, dataset_id, version_number, source_format, created_at)
          VALUES ('${dsvAId}', '${orgBId}', '${dsAId}', 1, 'h5ad', NOW());
        `)
        ).rejects.toThrow(/violates foreign key constraint "dataset_versions_dataset_org_fk"/);
      });

      it("E. rejects cross-tenant dataset_file -> dataset_version link", async () => {
        // Insert valid version in orgA
        await ownerPool.query(`
        INSERT INTO dataset_versions (id, organization_id, dataset_id, version_number, source_format, created_at)
        VALUES ('${dsvAId}', '${orgAId}', '${dsAId}', 1, 'h5ad', NOW());
      `);

        // Try inserting file linked to dsvAId (in orgA) but with organization_id = orgBId
        await expect(
          ownerPool.query(`
          INSERT INTO dataset_files (id, organization_id, dataset_version_id, r2_key, byte_size, file_name, content_type, etag, created_at)
          VALUES ('${dsfAId}', '${orgBId}', '${dsvAId}', 'data.h5ad', 1024, 'data.h5ad', 'application/x-hdf5', 'etag123', NOW());
        `)
        ).rejects.toThrow(/violates foreign key constraint "dataset_files_version_org_fk"/);
      });

      it("F. rejects cross-tenant upload_session -> project link", async () => {
        await expect(
          ownerPool.query(`
          INSERT INTO upload_sessions (
            id, organization_id, project_id, dataset_version_id, r2_key, r2_upload_id,
            status, expected_size, part_size, total_parts, expires_at, created_at, updated_at
          )
          VALUES (
            '${uplAId}', '${orgBId}', '${projAId}', '${dsvAId}', 'data.h5ad', 'r2_upl_1',
            'CREATED', 1024, 1024, 1, NOW() + INTERVAL '1 day', NOW(), NOW()
          );
        `)
        ).rejects.toThrow(/violates foreign key constraint "upload_sessions_project_org_fk"/);
      });

      it("G. rejects duplicate (experiment_id, sample_key)", async () => {
        await ownerPool.query(`
        INSERT INTO samples (id, organization_id, experiment_id, sample_key, metadata_json)
        VALUES ('${sampleAId}', '${orgAId}', '${expAId}', 'dup_key', '{}'::jsonb);
      `);

        const sampleDupId = `smp_${randomUUID()}`;
        await expect(
          ownerPool.query(`
          INSERT INTO samples (id, organization_id, experiment_id, sample_key, metadata_json)
          VALUES ('${sampleDupId}', '${orgAId}', '${expAId}', 'dup_key', '{}'::jsonb);
        `)
        ).rejects.toThrow(/violates unique constraint "samples_exp_key_unique"/);
      });

      it("H. rejects duplicate (dataset_id, version_number)", async () => {
        const dsvDupId = `dsv_${randomUUID()}`;
        await expect(
          ownerPool.query(`
          INSERT INTO dataset_versions (id, organization_id, dataset_id, version_number, source_format, created_at)
          VALUES ('${dsvDupId}', '${orgAId}', '${dsAId}', 1, 'h5ad', NOW());
        `)
        ).rejects.toThrow(/violates unique constraint "dataset_versions_ds_num_unique"/);
      });

      it("I. rejects duplicate (dataset_version_id, r2_key)", async () => {
        await ownerPool.query(`
        INSERT INTO dataset_files (id, organization_id, dataset_version_id, r2_key, byte_size, file_name, content_type, etag, created_at)
        VALUES ('${dsfAId}', '${orgAId}', '${dsvAId}', 'data.h5ad', 1024, 'data.h5ad', 'application/x-hdf5', 'etag123', NOW());
      `);

        const dsfDupId = `dsf_${randomUUID()}`;
        await expect(
          ownerPool.query(`
          INSERT INTO dataset_files (id, organization_id, dataset_version_id, r2_key, byte_size, file_name, content_type, etag, created_at)
          VALUES ('${dsfDupId}', '${orgAId}', '${dsvAId}', 'data.h5ad', 2048, 'data2.h5ad', 'application/x-hdf5', 'etag456', NOW());
        `)
        ).rejects.toThrow(/violates unique constraint "dataset_files_version_key_unique"/);
      }, 15000);

      it("J. rejects invalid upload status violating upload_sessions_status_check", async () => {
        await expect(
          ownerPool.query(`
          INSERT INTO upload_sessions (
            id, organization_id, project_id, dataset_version_id, r2_key, r2_upload_id,
            status, expected_size, part_size, total_parts, expires_at, created_at, updated_at
          )
          VALUES (
            '${uplAId}', '${orgAId}', '${projAId}', '${dsvAId}', 'data.h5ad', 'r2_upl_1',
            'INVALID_STATE', 1024, 1024, 1, NOW() + INTERVAL '1 day', NOW(), NOW()
          );
        `)
        ).rejects.toThrow(/violates check constraint "upload_sessions_status_check"/);
      });
    });

    describe("Section 18: Runtime Positive Privilege Probes (cellweave_app_runtime)", () => {
      const runtimeExpId = `exp_${randomUUID()}`;
      const runtimeSmpId = `smp_${randomUUID()}`;
      const runtimeDsId = `ds_${randomUUID()}`;
      const runtimeDsvId = `dsv_${randomUUID()}`;
      const runtimeDsfId = `dsf_${randomUUID()}`;
      const runtimeUplId = `upl_${randomUUID()}`;

      it("allows experiments SELECT, INSERT, UPDATE, DELETE", async () => {
        // INSERT
        await runtimePool.query(`
        INSERT INTO experiments (id, organization_id, project_id, name, created_by, created_at)
        VALUES ('${runtimeExpId}', '${orgAId}', '${projAId}', 'Runtime Exp', '${userIdA}', NOW());
      `);

        // SELECT
        const sel = await runtimePool.query(
          `SELECT id, name FROM experiments WHERE id = '${runtimeExpId}';`
        );
        expect(sel.rows.length).toBe(1);

        // UPDATE
        await runtimePool.query(
          `UPDATE experiments SET name = 'Updated Runtime Exp' WHERE id = '${runtimeExpId}';`
        );

        // DELETE
        await runtimePool.query(`DELETE FROM experiments WHERE id = '${runtimeExpId}';`);
        const postDel = await runtimePool.query(
          `SELECT id FROM experiments WHERE id = '${runtimeExpId}';`
        );
        expect(postDel.rows.length).toBe(0);
      });

      it("allows samples SELECT, INSERT, UPDATE, DELETE", async () => {
        // INSERT
        await runtimePool.query(`
        INSERT INTO samples (id, organization_id, experiment_id, sample_key, metadata_json)
        VALUES ('${runtimeSmpId}', '${orgAId}', '${expAId}', 'runtime_sample_1', '{}'::jsonb);
      `);

        // SELECT
        const sel = await runtimePool.query(`SELECT id FROM samples WHERE id = '${runtimeSmpId}';`);
        expect(sel.rows.length).toBe(1);

        // UPDATE
        await runtimePool.query(
          `UPDATE samples SET display_name = 'Sample 1' WHERE id = '${runtimeSmpId}';`
        );

        // DELETE
        await runtimePool.query(`DELETE FROM samples WHERE id = '${runtimeSmpId}';`);
        const postDel = await runtimePool.query(
          `SELECT id FROM samples WHERE id = '${runtimeSmpId}';`
        );
        expect(postDel.rows.length).toBe(0);
      });

      it("allows datasets SELECT, INSERT, UPDATE", async () => {
        // INSERT
        await runtimePool.query(`
        INSERT INTO datasets (id, organization_id, project_id, name, created_by, created_at)
        VALUES ('${runtimeDsId}', '${orgAId}', '${projAId}', 'Runtime Dataset', '${userIdA}', NOW());
      `);

        // SELECT
        const sel = await runtimePool.query(
          `SELECT id, name FROM datasets WHERE id = '${runtimeDsId}';`
        );
        expect(sel.rows.length).toBe(1);

        // UPDATE
        await runtimePool.query(
          `UPDATE datasets SET name = 'Renamed Dataset' WHERE id = '${runtimeDsId}';`
        );
      });

      it("allows dataset_versions SELECT, INSERT", async () => {
        // INSERT
        await runtimePool.query(`
        INSERT INTO dataset_versions (id, organization_id, dataset_id, version_number, source_format, created_at)
        VALUES ('${runtimeDsvId}', '${orgAId}', '${runtimeDsId}', 1, 'h5ad', NOW());
      `);

        // SELECT
        const sel = await runtimePool.query(
          `SELECT id, version_number FROM dataset_versions WHERE id = '${runtimeDsvId}';`
        );
        expect(sel.rows.length).toBe(1);
      });

      it("allows dataset_files SELECT, INSERT", async () => {
        // INSERT
        await runtimePool.query(`
        INSERT INTO dataset_files (id, organization_id, dataset_version_id, r2_key, byte_size, file_name, content_type, etag, created_at)
        VALUES ('${runtimeDsfId}', '${orgAId}', '${runtimeDsvId}', 'matrix.h5ad', 5000, 'matrix.h5ad', 'application/x-hdf5', 'etag_rt_1', NOW());
      `);

        // SELECT
        const sel = await runtimePool.query(
          `SELECT id FROM dataset_files WHERE id = '${runtimeDsfId}';`
        );
        expect(sel.rows.length).toBe(1);
      });

      it("allows upload_sessions SELECT, INSERT, UPDATE", async () => {
        // INSERT
        await runtimePool.query(`
        INSERT INTO upload_sessions (
          id, organization_id, project_id, dataset_version_id, r2_key, r2_upload_id,
          status, expected_size, part_size, total_parts, expires_at, created_at, updated_at
        )
        VALUES (
          '${runtimeUplId}', '${orgAId}', '${projAId}', '${runtimeDsvId}', 'matrix.h5ad', 'r2_upl_rt_1',
          'CREATED', 5000, 5000, 1, NOW() + INTERVAL '1 day', NOW(), NOW()
        );
      `);

        // SELECT
        const sel = await runtimePool.query(
          `SELECT id, status FROM upload_sessions WHERE id = '${runtimeUplId}';`
        );
        expect(sel.rows.length).toBe(1);

        // UPDATE
        await runtimePool.query(
          `UPDATE upload_sessions SET status = 'UPLOADING' WHERE id = '${runtimeUplId}';`
        );
        const postUpd = await runtimePool.query(
          `SELECT status FROM upload_sessions WHERE id = '${runtimeUplId}';`
        );
        expect(postUpd.rows[0].status).toBe("UPLOADING");
      });
    });

    describe("Section 19: Runtime Negative Privilege Probes (cellweave_app_runtime)", () => {
      it("rejects DELETE FROM projects", async () => {
        await expect(
          runtimePool.query(`DELETE FROM projects WHERE id = '${projAId}';`)
        ).rejects.toThrow(/permission denied for table projects/);
      });

      it("rejects DELETE FROM datasets", async () => {
        await expect(
          runtimePool.query(`DELETE FROM datasets WHERE id = '${dsAId}';`)
        ).rejects.toThrow(/permission denied for table datasets/);
      });

      it("rejects UPDATE dataset_versions", async () => {
        await expect(
          runtimePool.query(
            `UPDATE dataset_versions SET source_format = 'mtx' WHERE id = '${dsvAId}';`
          )
        ).rejects.toThrow(/permission denied for table dataset_versions/);
      });

      it("rejects DELETE FROM dataset_versions", async () => {
        await expect(
          runtimePool.query(`DELETE FROM dataset_versions WHERE id = '${dsvAId}';`)
        ).rejects.toThrow(/permission denied for table dataset_versions/);
      });

      it("rejects UPDATE dataset_files", async () => {
        await expect(
          runtimePool.query(`UPDATE dataset_files SET byte_size = 9999 WHERE id = '${dsfAId}';`)
        ).rejects.toThrow(/permission denied for table dataset_files/);
      });

      it("rejects DELETE FROM dataset_files", async () => {
        await expect(
          runtimePool.query(`DELETE FROM dataset_files WHERE id = '${dsfAId}';`)
        ).rejects.toThrow(/permission denied for table dataset_files/);
      });

      it("rejects DELETE FROM upload_sessions", async () => {
        await expect(
          runtimePool.query(`DELETE FROM upload_sessions WHERE organization_id = '${orgAId}';`)
        ).rejects.toThrow(/permission denied for table upload_sessions/);
      });

      it("rejects TRUNCATE on all Phase 2 tables and projects", async () => {
        const tables = [
          "projects",
          "experiments",
          "samples",
          "datasets",
          "dataset_versions",
          "dataset_files",
          "upload_sessions",
        ];
        for (const t of tables) {
          await expect(runtimePool.query(`TRUNCATE TABLE ${t};`)).rejects.toThrow(
            new RegExp(`permission denied for table ${t}`)
          );
        }
      }, 30000);

      it("rejects CREATE TABLE in public schema", async () => {
        await expect(
          runtimePool.query(`CREATE TABLE test_runtime_unauth (id text primary key);`)
        ).rejects.toThrow(/permission denied for schema public/);
      });

      it("rejects ALTER TABLE on Phase 2 tables", async () => {
        await expect(
          runtimePool.query(`ALTER TABLE datasets ADD COLUMN unauth_col text;`)
        ).rejects.toThrow(/must be owner of table datasets/);
      });

      it("rejects DROP TABLE on Phase 2 tables", async () => {
        await expect(runtimePool.query(`DROP TABLE datasets;`)).rejects.toThrow(
          /must be owner of table datasets/
        );
      });
    });
  }
);

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
const sql = readFileSync(
  "src/server/database/migrations/0005_phase4_execution_infrastructure.sql",
  "utf8"
);
describe("Phase 4 operational persistence security", () => {
  it("enforces tenant-composite parent relationships", () => {
    expect(sql).toContain("FOREIGN KEY(dataset_version_id,organization_id)");
    expect(sql).toContain("FOREIGN KEY(project_id,organization_id)");
    expect(sql).toContain("FOREIGN KEY(analysis_run_id,organization_id)");
  });
  it("uniquely binds durable request and external submission identities", () => {
    expect(sql).toContain("UNIQUE(organization_id,actor_id,request_key)");
    expect(sql).toContain("temporal_workflow_id text NOT NULL UNIQUE");
    expect(sql).toContain("submission_id text NOT NULL UNIQUE");
  });
  it("grants only operational DML and does not rewrite scientific finalization", () => {
    expect(sql).toContain(
      "GRANT SELECT,INSERT,UPDATE ON analysis_runs,workflow_steps TO cellweave_app_runtime"
    );
    expect(sql).toContain("REVOKE DELETE,TRUNCATE");
    expect(sql).not.toMatch(
      /UPDATE dataset_versions|CREATE.*FUNCTION|GRANT.*cellweave_import_finalizer/i
    );
  });
});

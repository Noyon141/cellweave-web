import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const sql = readFileSync(
  "src/server/database/migrations/0006_phase5_qc_review_and_artifacts.sql",
  "utf8"
);
describe("Phase 5 immutable scientific persistence declarations", () => {
  it.each(["artifacts", "artifact_lineage", "qc_decisions"])(
    "rejects mutation of %s even for privileged application connections",
    (table) => {
      expect(sql).toContain("CREATE TRIGGER " + table + "_immutable BEFORE UPDATE OR DELETE");
    }
  );
  it("uses tenant/run composite references for decisions and masks", () => {
    expect(sql).toContain(
      "FOREIGN KEY(selection_artifact_id,organization_id,project_id,analysis_run_id)"
    );
    expect(sql).toContain("UNIQUE(analysis_run_id,qc_revision)");
    expect(sql).toContain("approval_pending boolean NOT NULL DEFAULT false");
  });
  it("keeps runtime immutable-table privileges restricted", () => {
    expect(sql).toContain(
      "GRANT SELECT,INSERT ON artifacts,artifact_lineage,qc_decisions TO cellweave_app_runtime"
    );
    expect(sql).not.toContain("UPDATE dataset_versions");
  });
});

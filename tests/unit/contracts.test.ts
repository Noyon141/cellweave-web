import { describe, it, expect } from "vitest";
import {
  RUN_STATES,
  WORKFLOW_STEP_STATES,
  UPLOAD_STATES,
  ACCOUNT_STATES,
  RESOURCE_CLASSES,
  ARTIFACT_TYPES,
  SCIENTIFIC_JOB_TYPES,
  type OrganizationId,
  type ProjectId,
  type AnalysisRunId,
} from "@/types";

describe("Cross-Language Contracts Integration", () => {
  it("imports canonical run states from generated contracts", () => {
    expect(RUN_STATES).toContain("RUNNING");
    expect(RUN_STATES).toContain("SUCCEEDED");
    expect(RUN_STATES).toContain("FAILED");
    expect(RUN_STATES).toContain("QC_REVIEW_REQUIRED");
  });

  it("imports canonical workflow step states from generated contracts", () => {
    expect(WORKFLOW_STEP_STATES).toContain("PENDING");
    expect(WORKFLOW_STEP_STATES).toContain("RUNNING");
    expect(WORKFLOW_STEP_STATES).toContain("SUCCEEDED");
  });

  it("imports canonical upload states from generated contracts", () => {
    expect(UPLOAD_STATES).toContain("CREATED");
    expect(UPLOAD_STATES).toContain("UPLOADING");
    expect(UPLOAD_STATES).toContain("VERIFIED");
    expect(UPLOAD_STATES).toContain("QUARANTINED");
  });

  it("imports canonical artifact types from generated contracts", () => {
    expect(ARTIFACT_TYPES).toContain("CANONICAL_DATASET");
    expect(ARTIFACT_TYPES).toContain("RUN_MANIFEST");
    expect(ARTIFACT_TYPES).toContain("EXPORT_BUNDLE");
  });

  it("imports canonical account states, resource classes, and scientific jobs", () => {
    expect(ACCOUNT_STATES).toContain("ACTIVE");
    expect(RESOURCE_CLASSES).toContain("CPU_SMALL");
    expect(RESOURCE_CLASSES).toContain("GPU_SMALL");
    expect(SCIENTIFIC_JOB_TYPES).toContain("validate_dataset");
    expect(SCIENTIFIC_JOB_TYPES).toContain("run_qc");
  });

  it("supports branded domain identifiers", () => {
    const orgId = "org_123" as OrganizationId;
    const projId = "proj_456" as ProjectId;
    const runId = "run_789" as AnalysisRunId;

    expect(typeof orgId).toBe("string");
    expect(typeof projId).toBe("string");
    expect(typeof runId).toBe("string");
  });
});

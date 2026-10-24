import {
  pgTable,
  text,
  jsonb,
  bigint,
  integer,
  boolean,
  timestamp,
  unique,
  index,
  foreignKey,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { QcAnalysisParameters, QcDecision } from "@cellweave/contracts";
import { analysisRuns, workflowSteps } from "./executions";
import { datasetVersions } from "./datasets";
import { projects } from "./projects";
export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    datasetVersionId: text("dataset_version_id").notNull(),
    analysisRunId: text("analysis_run_id"),
    workflowStepId: text("workflow_step_id"),
    artifactType: text("artifact_type")
      .$type<"CANONICAL_DATASET" | "QC_REPORT" | "FILTERED_DATASET">()
      .notNull(),
    storageProvider: text("storage_provider").notNull().default("R2"),
    bucket: text("bucket").notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mimeType: text("mime_type").notNull(),
    pipelineVersion: text("pipeline_version"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.id, t.organizationId),
    unique().on(t.id, t.organizationId, t.projectId),
    unique().on(t.id, t.organizationId, t.projectId, t.analysisRunId),
    unique().on(t.organizationId, t.objectKey),
    index("artifacts_run_idx").on(t.organizationId, t.analysisRunId),
    uniqueIndex("artifacts_canonical_version_unique")
      .on(t.datasetVersionId, t.organizationId)
      .where(sql`artifact_type='CANONICAL_DATASET'`),
    foreignKey({
      columns: [t.datasetVersionId, t.organizationId],
      foreignColumns: [datasetVersions.id, datasetVersions.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.analysisRunId, t.organizationId],
      foreignColumns: [analysisRuns.id, analysisRuns.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.workflowStepId, t.organizationId, t.analysisRunId],
      foreignColumns: [workflowSteps.id, workflowSteps.organizationId, workflowSteps.analysisRunId],
    }).onDelete("restrict"),
  ]
);
export const artifactLineage = pgTable(
  "artifact_lineage",
  {
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    analysisRunId: text("analysis_run_id").notNull(),
    parentArtifactId: text("parent_artifact_id").notNull(),
    childArtifactId: text("child_artifact_id").notNull(),
    relationship: text("relationship").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.parentArtifactId, t.childArtifactId, t.relationship] }),
    foreignKey({
      columns: [t.parentArtifactId, t.organizationId, t.projectId],
      foreignColumns: [artifacts.id, artifacts.organizationId, artifacts.projectId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.childArtifactId, t.organizationId, t.projectId, t.analysisRunId],
      foreignColumns: [
        artifacts.id,
        artifacts.organizationId,
        artifacts.projectId,
        artifacts.analysisRunId,
      ],
    }).onDelete("restrict"),
  ]
);
export const qcDecisions = pgTable(
  "qc_decisions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    analysisRunId: text("analysis_run_id").notNull(),
    datasetVersionId: text("dataset_version_id").notNull(),
    qcRevision: integer("qc_revision").notNull(),
    previewStepId: text("preview_step_id").notNull(),
    selectionArtifactId: text("selection_artifact_id").notNull(),
    requestKey: text("request_key").notNull(),
    requestChecksum: text("request_checksum").notNull(),
    actorId: text("actor_id").notNull(),
    decision: jsonb("decision").$type<QcDecision>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.analysisRunId, t.qcRevision),
    unique().on(t.id, t.organizationId, t.analysisRunId),
    unique().on(t.organizationId, t.actorId, t.requestKey),
    foreignKey({
      columns: [t.analysisRunId, t.organizationId],
      foreignColumns: [analysisRuns.id, analysisRuns.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.datasetVersionId, t.organizationId],
      foreignColumns: [datasetVersions.id, datasetVersions.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.previewStepId, t.organizationId, t.analysisRunId],
      foreignColumns: [workflowSteps.id, workflowSteps.organizationId, workflowSteps.analysisRunId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.selectionArtifactId, t.organizationId, t.projectId, t.analysisRunId],
      foreignColumns: [
        artifacts.id,
        artifacts.organizationId,
        artifacts.projectId,
        artifacts.analysisRunId,
      ],
    }).onDelete("restrict"),
  ]
);
export const qcRevisions = pgTable(
  "qc_revisions",
  {
    analysisRunId: text("analysis_run_id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    qcRevision: integer("qc_revision").notNull().default(1),
    canonicalArtifactId: text("canonical_artifact_id").notNull(),
    qcStepId: text("qc_step_id").notNull(),
    previewStepId: text("preview_step_id"),
    previewRevision: integer("preview_revision").notNull().default(0),
    decisionId: text("decision_id"),
    cancelActorId: text("cancel_actor_id"),
    approvalPending: boolean("approval_pending").notNull().default(false),
    filterCommitted: boolean("filter_committed").notNull().default(false),
    analysisParameters: jsonb("analysis_parameters").$type<QcAnalysisParameters>().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.analysisRunId, t.organizationId],
      foreignColumns: [analysisRuns.id, analysisRuns.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.canonicalArtifactId, t.organizationId, t.projectId],
      foreignColumns: [artifacts.id, artifacts.organizationId, artifacts.projectId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.qcStepId, t.organizationId, t.analysisRunId],
      foreignColumns: [workflowSteps.id, workflowSteps.organizationId, workflowSteps.analysisRunId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.previewStepId, t.organizationId, t.analysisRunId],
      foreignColumns: [workflowSteps.id, workflowSteps.organizationId, workflowSteps.analysisRunId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.decisionId, t.organizationId, t.analysisRunId],
      foreignColumns: [qcDecisions.id, qcDecisions.organizationId, qcDecisions.analysisRunId],
    }).onDelete("restrict"),
  ]
);

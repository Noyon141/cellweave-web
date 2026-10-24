import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  unique,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import type {
  ExecutionEnvelope,
  QcStepContext,
  QcJobResult,
  ExecutionResult,
  RunState,
  WorkflowStepState,
} from "@cellweave/contracts";
import { datasetVersions } from "./datasets";
import { projects } from "./projects";

/** Master-design business run; no scientific arrays or ephemeral credentials. */
export const analysisRuns = pgTable(
  "analysis_runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    datasetVersionId: text("dataset_version_id").notNull(),
    kind: text("kind").$type<"IMPORT" | "QC">().notNull().default("IMPORT"),
    pipelineVersion: text("pipeline_version").notNull(),
    actorId: text("actor_id").notNull(),
    requestKey: text("request_key").notNull(),
    requestChecksum: text("request_checksum").notNull(),
    executorSubject: text("executor_subject").notNull(),
    temporalWorkflowId: text("temporal_workflow_id").notNull().unique(),
    status: text("status").$type<RunState>().notNull().default("START_PENDING"),
    envelope: jsonb("execution_envelope").$type<ExecutionEnvelope>().notNull(),
    projectionVersion: integer("projection_version").notNull().default(0),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("analysis_runs_actor_request_unique").on(t.organizationId, t.actorId, t.requestKey),
    unique("analysis_runs_id_org_unique").on(t.id, t.organizationId),
    foreignKey({
      columns: [t.datasetVersionId, t.organizationId],
      foreignColumns: [datasetVersions.id, datasetVersions.organizationId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("restrict"),
    index("analysis_runs_org_status_idx").on(t.organizationId, t.status),
  ]
);
export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    analysisRunId: text("analysis_run_id").notNull(),
    stepKey: text("step_key").notNull(),
    stepVersion: text("step_version").notNull(),
    submissionId: text("submission_id").notNull().unique(),
    providerJobId: text("provider_job_id"),
    providerState: text("provider_state").notNull().default("UNKNOWN"),
    status: text("status").$type<WorkflowStepState>().notNull().default("PENDING"),
    attempt: integer("attempt").notNull().default(0),
    finalizationStarted: boolean("finalization_started").notNull().default(false),
    result: jsonb("result").$type<ExecutionResult>(),
    qcContext: jsonb("qc_context").$type<QcStepContext>(),
    qcResult: jsonb("qc_result").$type<QcJobResult>(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.analysisRunId, t.organizationId],
      foreignColumns: [analysisRuns.id, analysisRuns.organizationId],
    }).onDelete("cascade"),
    unique("workflow_steps_id_org_run_unique").on(t.id, t.organizationId, t.analysisRunId),
    unique("workflow_steps_run_key_unique").on(t.analysisRunId, t.stepKey),
  ]
);

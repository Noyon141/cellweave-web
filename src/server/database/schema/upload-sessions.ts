import {
  pgTable,
  text,
  integer,
  bigint,
  timestamp,
  index,
  uniqueIndex,
  unique,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql, relations } from "drizzle-orm";
import { organization } from "./auth";
import { projects } from "./projects";
import { datasetVersions } from "./datasets";

/**
 * Upload Sessions Schema (Phase 2 Resumable Direct Multipart Uploads)
 *
 * Invariants:
 * 1. R2 ListParts is the authoritative source of truth for uploaded parts.
 *    No uploadedParts JSONB is stored in the database.
 * 2. status check constraint matches canonical @cellweave/contracts UploadState.
 * 3. Composite FKs guarantee that upload session cannot cross tenant or project boundaries.
 * 4. upload_sessions_active_object_unique partial unique index guarantees that at most one
 *    active upload session exists for (organizationId, datasetVersionId, r2Key).
 */
export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull(),
    datasetVersionId: text("dataset_version_id").notNull(),
    r2Key: text("r2_key").notNull(),
    r2UploadId: text("r2_upload_id").notNull(),
    status: text("status").default("CREATED").notNull(),
    expectedSize: bigint("expected_size", { mode: "number" }).notNull(),
    partSize: integer("part_size").notNull(),
    totalParts: integer("total_parts").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    failureCode: text("failure_code"),
    failureSummary: text("failure_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("upload_sessions_id_org_ver_r2_unique").on(
      table.id,
      table.organizationId,
      table.datasetVersionId,
      table.r2Key
    ),
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: "upload_sessions_project_org_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.datasetVersionId, table.organizationId],
      foreignColumns: [datasetVersions.id, datasetVersions.organizationId],
      name: "upload_sessions_version_org_fk",
    }).onDelete("cascade"),
    check(
      "upload_sessions_status_check",
      sql`status IN ('CREATED', 'UPLOADING', 'UPLOADED', 'VERIFYING', 'VERIFIED', 'IMPORTED', 'FAILED', 'ABORTED', 'EXPIRED', 'QUARANTINED')`
    ),
    index("upload_sessions_org_project_idx").on(table.organizationId, table.projectId),
    index("upload_sessions_org_version_idx").on(table.organizationId, table.datasetVersionId),
    index("upload_sessions_status_expires_idx").on(table.status, table.expiresAt),
    uniqueIndex("upload_sessions_active_object_unique")
      .on(table.organizationId, table.datasetVersionId, table.r2Key)
      .where(sql`status IN ('CREATED', 'UPLOADING', 'UPLOADED', 'VERIFYING')`),
  ]
);

export const uploadSessionsRelations = relations(uploadSessions, ({ one }) => ({
  organization: one(organization, {
    fields: [uploadSessions.organizationId],
    references: [organization.id],
  }),
  project: one(projects, {
    fields: [uploadSessions.projectId],
    references: [projects.id],
  }),
  datasetVersion: one(datasetVersions, {
    fields: [uploadSessions.datasetVersionId],
    references: [datasetVersions.id],
  }),
}));

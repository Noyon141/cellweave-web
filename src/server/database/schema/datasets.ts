import {
  pgTable,
  text,
  integer,
  bigint,
  timestamp,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organization, user } from "./auth";
import { projects } from "./projects";

/**
 * Datasets Schema (Phase 2 Logical Dataset Identity)
 *
 * Invariant: Represents permanent logical dataset identity within a project.
 * Large scientific matrices are never stored in PostgreSQL.
 */
export const datasets = pgTable(
  "datasets",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").default("active").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("datasets_id_org_unique").on(table.id, table.organizationId),
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: "datasets_project_org_fk",
    }).onDelete("cascade"),
    index("datasets_org_project_idx").on(table.organizationId, table.projectId),
    index("datasets_org_status_idx").on(table.organizationId, table.status),
  ]
);

/**
 * Dataset Versions Schema (Phase 2 Immutable Dataset Revisions)
 *
 * Invariants:
 * 1. Monotonically allocated versionNumber unique per dataset.
 * 2. Immutable revision: never overwritten after becoming input to an analysis.
 * 3. All Phase 3 scientific metadata columns are nullable during Phase 2 upload.
 */
export const datasetVersions = pgTable(
  "dataset_versions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    datasetId: text("dataset_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    sourceFormat: text("source_format").notNull(),
    canonicalFormat: text("canonical_format"),
    organism: text("organism"),
    geneIdScheme: text("gene_id_scheme"),
    referenceBuild: text("reference_build"),
    cellCount: integer("cell_count"),
    geneCount: integer("gene_count"),
    sourceChecksum: text("source_checksum"),
    canonicalChecksum: text("canonical_checksum"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("dataset_versions_ds_num_unique").on(table.datasetId, table.versionNumber),
    unique("dataset_versions_id_org_unique").on(table.id, table.organizationId),
    foreignKey({
      columns: [table.datasetId, table.organizationId],
      foreignColumns: [datasets.id, datasets.organizationId],
      name: "dataset_versions_dataset_org_fk",
    }).onDelete("cascade"),
    index("dataset_versions_org_dataset_idx").on(table.organizationId, table.datasetId),
  ]
);

/**
 * Dataset Files Schema (Phase 2 Verified Physical Object Bindings)
 *
 * Invariants:
 * 1. Represents verified physical R2 objects bound to a dataset version.
 * 2. Inserted exclusively upon verified physical completion in R2.
 * 3. UNIQUE(datasetVersionId, r2Key) prevents duplicate bindings while allowing
 *    multiple source files per dataset version (for multi-file 10x MTX datasets).
 */
export const datasetFiles = pgTable(
  "dataset_files",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    datasetVersionId: text("dataset_version_id").notNull(),
    r2Key: text("r2_key").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    eTag: text("etag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("dataset_files_version_key_unique").on(table.datasetVersionId, table.r2Key),
    foreignKey({
      columns: [table.datasetVersionId, table.organizationId],
      foreignColumns: [datasetVersions.id, datasetVersions.organizationId],
      name: "dataset_files_version_org_fk",
    }).onDelete("cascade"),
    index("dataset_files_org_version_idx").on(table.organizationId, table.datasetVersionId),
  ]
);

export const datasetsRelations = relations(datasets, ({ one, many }) => ({
  organization: one(organization, {
    fields: [datasets.organizationId],
    references: [organization.id],
  }),
  project: one(projects, {
    fields: [datasets.projectId],
    references: [projects.id],
  }),
  creator: one(user, {
    fields: [datasets.createdBy],
    references: [user.id],
  }),
  versions: many(datasetVersions),
}));

export const datasetVersionsRelations = relations(datasetVersions, ({ one, many }) => ({
  organization: one(organization, {
    fields: [datasetVersions.organizationId],
    references: [organization.id],
  }),
  dataset: one(datasets, {
    fields: [datasetVersions.datasetId],
    references: [datasets.id],
  }),
  files: many(datasetFiles),
}));

export const datasetFilesRelations = relations(datasetFiles, ({ one }) => ({
  organization: one(organization, {
    fields: [datasetFiles.organizationId],
    references: [organization.id],
  }),
  datasetVersion: one(datasetVersions, {
    fields: [datasetFiles.datasetVersionId],
    references: [datasetVersions.id],
  }),
}));

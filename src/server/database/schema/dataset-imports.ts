import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
  unique,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql, relations } from "drizzle-orm";
import { organization } from "./auth";
import { datasetVersions, datasetFiles } from "./datasets";
import { uploadSessions } from "./upload-sessions";

/**
 * Dataset File Provenance Schema (Phase 3 Verified Physical File Provenance)
 *
 * Invariants:
 * 1. Exactly 1 provenance record per dataset file.
 * 2. Immutable physical cryptographic proof (sha256, compression).
 * 3. Dual composite foreign keys enforce that dataset file and upload session
 *    share the identical tenant identity, dataset version, and physical R2 key.
 */
export const datasetFileProvenance = pgTable(
  "dataset_file_provenance",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    datasetVersionId: text("dataset_version_id").notNull(),
    datasetFileId: text("dataset_file_id").notNull(),
    uploadSessionId: text("upload_session_id").notNull(),
    r2Key: text("r2_key").notNull(),
    sha256: text("sha256").notNull(),
    compression: text("compression").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("dataset_file_provenance_file_unique").on(table.datasetFileId),
    unique("dataset_file_provenance_session_unique").on(table.uploadSessionId),
    foreignKey({
      columns: [table.datasetFileId, table.organizationId, table.datasetVersionId, table.r2Key],
      foreignColumns: [
        datasetFiles.id,
        datasetFiles.organizationId,
        datasetFiles.datasetVersionId,
        datasetFiles.r2Key,
      ],
      name: "dataset_file_provenance_file_org_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.uploadSessionId, table.organizationId, table.datasetVersionId, table.r2Key],
      foreignColumns: [
        uploadSessions.id,
        uploadSessions.organizationId,
        uploadSessions.datasetVersionId,
        uploadSessions.r2Key,
      ],
      name: "dataset_file_provenance_session_org_fk",
    }).onDelete("restrict"),
    check("dataset_file_provenance_sha256_check", sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check("dataset_file_provenance_compression_check", sql`compression IN ('NONE', 'GZIP')`),
    index("dataset_file_provenance_org_ver_idx").on(table.organizationId, table.datasetVersionId),
  ]
);

/**
 * Dataset Imports Schema (Phase 3 Immutable Import Manifest Root)
 *
 * Invariants:
 * 1. Exactly 1 import manifest per dataset version.
 * 2. Immutable provenance root recording source format and composite checksum.
 * 3. Referenced files are normalized into dataset_import_files.
 */
export const datasetImports = pgTable(
  "dataset_imports",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    datasetVersionId: text("dataset_version_id").notNull(),
    sourceFormat: text("source_format").notNull(),
    sourceChecksum: text("source_checksum").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("dataset_imports_version_unique").on(table.datasetVersionId),
    unique("dataset_imports_id_org_unique").on(table.id, table.organizationId),
    unique("dataset_imports_id_org_ver_unique").on(
      table.id,
      table.organizationId,
      table.datasetVersionId
    ),
    foreignKey({
      columns: [table.datasetVersionId, table.organizationId],
      foreignColumns: [datasetVersions.id, datasetVersions.organizationId],
      name: "dataset_imports_version_org_fk",
    }).onDelete("restrict"),
    check(
      "dataset_imports_source_format_check",
      sql`source_format IN ('H5AD', 'TENX_H5', 'TENX_MTX', 'GENERIC_MATRIX')`
    ),
    check("dataset_imports_source_checksum_check", sql`source_checksum ~ '^[0-9a-f]{64}$'`),
    index("dataset_imports_org_ver_idx").on(table.organizationId, table.datasetVersionId),
  ]
);

/**
 * Dataset Import Files Schema (Phase 3 Normalized Import Manifest File Members)
 *
 * Invariants:
 * 1. Normalized relational membership of files contributing to an import manifest.
 * 2. Composite FKs guarantee tenant and version alignment with dataset_files.
 * 3. Cardinality and roles strictly constrained.
 */
export const datasetImportFiles = pgTable(
  "dataset_import_files",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    datasetVersionId: text("dataset_version_id").notNull(),
    importId: text("import_id").notNull(),
    datasetFileId: text("dataset_file_id").notNull(),
    role: text("role").notNull(),
    ordinal: integer("ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("dataset_import_files_import_file_unique").on(table.importId, table.datasetFileId),
    unique("dataset_import_files_import_role_ord_unique").on(
      table.importId,
      table.role,
      table.ordinal
    ),
    foreignKey({
      columns: [table.importId, table.organizationId, table.datasetVersionId],
      foreignColumns: [
        datasetImports.id,
        datasetImports.organizationId,
        datasetImports.datasetVersionId,
      ],
      name: "dataset_import_files_import_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.datasetFileId, table.organizationId, table.datasetVersionId],
      foreignColumns: [datasetFiles.id, datasetFiles.organizationId, datasetFiles.datasetVersionId],
      name: "dataset_import_files_file_fk",
    }).onDelete("restrict"),
    check(
      "dataset_import_files_role_check",
      sql`role IN ('PRIMARY', 'MATRIX', 'FEATURES', 'BARCODES', 'CELL_METADATA', 'FEATURE_METADATA')`
    ),
    check("dataset_import_files_ordinal_check", sql`ordinal >= 0`),
    index("dataset_import_files_org_ver_idx").on(table.organizationId, table.datasetVersionId),
    index("dataset_import_files_import_idx").on(table.importId),
  ]
);

export const datasetFileProvenanceRelations = relations(datasetFileProvenance, ({ one }) => ({
  organization: one(organization, {
    fields: [datasetFileProvenance.organizationId],
    references: [organization.id],
  }),
  datasetVersion: one(datasetVersions, {
    fields: [datasetFileProvenance.datasetVersionId],
    references: [datasetVersions.id],
  }),
  datasetFile: one(datasetFiles, {
    fields: [datasetFileProvenance.datasetFileId],
    references: [datasetFiles.id],
  }),
  uploadSession: one(uploadSessions, {
    fields: [datasetFileProvenance.uploadSessionId],
    references: [uploadSessions.id],
  }),
}));

export const datasetImportsRelations = relations(datasetImports, ({ one, many }) => ({
  organization: one(organization, {
    fields: [datasetImports.organizationId],
    references: [organization.id],
  }),
  datasetVersion: one(datasetVersions, {
    fields: [datasetImports.datasetVersionId],
    references: [datasetVersions.id],
  }),
  files: many(datasetImportFiles),
}));

export const datasetImportFilesRelations = relations(datasetImportFiles, ({ one }) => ({
  organization: one(organization, {
    fields: [datasetImportFiles.organizationId],
    references: [organization.id],
  }),
  datasetVersion: one(datasetVersions, {
    fields: [datasetImportFiles.datasetVersionId],
    references: [datasetVersions.id],
  }),
  import: one(datasetImports, {
    fields: [datasetImportFiles.importId],
    references: [datasetImports.id],
  }),
  datasetFile: one(datasetFiles, {
    fields: [datasetImportFiles.datasetFileId],
    references: [datasetFiles.id],
  }),
}));

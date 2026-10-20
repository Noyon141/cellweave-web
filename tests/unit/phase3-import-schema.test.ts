import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import {
  datasetFiles,
  uploadSessions,
  datasetFileProvenance,
  datasetImports,
  datasetImportFiles,
} from "@/server/database/schema";

describe("Phase 3 Import Drizzle Schema Invariants", () => {
  describe("datasetFiles candidate keys", () => {
    const cols = getTableColumns(datasetFiles);

    it("has required columns for composite candidate key", () => {
      expect(cols).toHaveProperty("id");
      expect(cols).toHaveProperty("organizationId");
      expect(cols).toHaveProperty("datasetVersionId");
      expect(cols).toHaveProperty("r2Key");
      expect(cols.id.notNull).toBe(true);
      expect(cols.organizationId.notNull).toBe(true);
      expect(cols.datasetVersionId.notNull).toBe(true);
      expect(cols.r2Key.notNull).toBe(true);
    });
  });

  describe("uploadSessions candidate keys", () => {
    const cols = getTableColumns(uploadSessions);

    it("has required columns for composite candidate key", () => {
      expect(cols).toHaveProperty("id");
      expect(cols).toHaveProperty("organizationId");
      expect(cols).toHaveProperty("datasetVersionId");
      expect(cols).toHaveProperty("r2Key");
      expect(cols.id.notNull).toBe(true);
      expect(cols.organizationId.notNull).toBe(true);
      expect(cols.datasetVersionId.notNull).toBe(true);
      expect(cols.r2Key.notNull).toBe(true);
    });
  });

  describe("datasetFileProvenance table", () => {
    const cols = getTableColumns(datasetFileProvenance);

    it("has exact authoritative fields", () => {
      expect(cols).toHaveProperty("id");
      expect(cols).toHaveProperty("organizationId");
      expect(cols).toHaveProperty("datasetVersionId");
      expect(cols).toHaveProperty("datasetFileId");
      expect(cols).toHaveProperty("uploadSessionId");
      expect(cols).toHaveProperty("r2Key");
      expect(cols).toHaveProperty("sha256");
      expect(cols).toHaveProperty("compression");
      expect(cols).toHaveProperty("createdAt");
    });

    it("enforces primary key and mandatory non-null fields", () => {
      expect(cols.id.primary).toBe(true);
      expect(cols.organizationId.notNull).toBe(true);
      expect(cols.datasetVersionId.notNull).toBe(true);
      expect(cols.datasetFileId.notNull).toBe(true);
      expect(cols.uploadSessionId.notNull).toBe(true);
      expect(cols.r2Key.notNull).toBe(true);
      expect(cols.sha256.notNull).toBe(true);
      expect(cols.compression.notNull).toBe(true);
      expect(cols.createdAt.notNull).toBe(true);
    });

    it("does not contain speculative or mutable fields", () => {
      expect(cols).not.toHaveProperty("updatedAt");
      expect(cols).not.toHaveProperty("updated_at");
      expect(cols).not.toHaveProperty("status");
    });
  });

  describe("datasetImports table", () => {
    const cols = getTableColumns(datasetImports);

    it("has exact authoritative fields", () => {
      expect(cols).toHaveProperty("id");
      expect(cols).toHaveProperty("organizationId");
      expect(cols).toHaveProperty("datasetVersionId");
      expect(cols).toHaveProperty("sourceFormat");
      expect(cols).toHaveProperty("sourceChecksum");
      expect(cols).toHaveProperty("createdAt");
    });

    it("enforces primary key and mandatory non-null fields", () => {
      expect(cols.id.primary).toBe(true);
      expect(cols.organizationId.notNull).toBe(true);
      expect(cols.datasetVersionId.notNull).toBe(true);
      expect(cols.sourceFormat.notNull).toBe(true);
      expect(cols.sourceChecksum.notNull).toBe(true);
      expect(cols.createdAt.notNull).toBe(true);
    });

    it("does not contain speculative fields or mutable finalization outputs", () => {
      expect(cols).not.toHaveProperty("canonicalChecksum");
      expect(cols).not.toHaveProperty("canonicalArtifactKey");
      expect(cols).not.toHaveProperty("finalizedAt");
      expect(cols).not.toHaveProperty("updatedAt");
    });
  });

  describe("datasetImportFiles table", () => {
    const cols = getTableColumns(datasetImportFiles);

    it("has exact authoritative fields", () => {
      expect(cols).toHaveProperty("id");
      expect(cols).toHaveProperty("organizationId");
      expect(cols).toHaveProperty("datasetVersionId");
      expect(cols).toHaveProperty("importId");
      expect(cols).toHaveProperty("datasetFileId");
      expect(cols).toHaveProperty("role");
      expect(cols).toHaveProperty("ordinal");
      expect(cols).toHaveProperty("createdAt");
    });

    it("enforces primary key and mandatory non-null fields", () => {
      expect(cols.id.primary).toBe(true);
      expect(cols.organizationId.notNull).toBe(true);
      expect(cols.datasetVersionId.notNull).toBe(true);
      expect(cols.importId.notNull).toBe(true);
      expect(cols.datasetFileId.notNull).toBe(true);
      expect(cols.role.notNull).toBe(true);
      expect(cols.ordinal.notNull).toBe(true);
      expect(cols.createdAt.notNull).toBe(true);
    });

    it("does not contain speculative or mutable fields", () => {
      expect(cols).not.toHaveProperty("status");
      expect(cols).not.toHaveProperty("updatedAt");
    });
  });
});

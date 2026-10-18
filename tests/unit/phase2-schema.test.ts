import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import {
  experiments,
  samples,
  datasets,
  datasetVersions,
  datasetFiles,
  uploadSessions,
} from "@/server/database/schema";

describe("Phase 2 Drizzle Schema Invariants", () => {
  describe("experiments table", () => {
    const cols = getTableColumns(experiments);

    it("has exact authoritative fields", () => {
      expect(cols).toHaveProperty("id");
      expect(cols).toHaveProperty("organizationId");
      expect(cols).toHaveProperty("projectId");
      expect(cols).toHaveProperty("name");
      expect(cols).toHaveProperty("description");
      expect(cols).toHaveProperty("organism");
      expect(cols).toHaveProperty("tissue");
      expect(cols).toHaveProperty("diseaseContext");
      expect(cols).toHaveProperty("createdBy");
      expect(cols).toHaveProperty("createdAt");
    });

    it("does not contain speculative fields", () => {
      expect(cols).not.toHaveProperty("metadataJson");
      expect(cols).not.toHaveProperty("metadata_json");
      expect(cols).not.toHaveProperty("updatedAt");
      expect(cols).not.toHaveProperty("updated_at");
      expect(cols).not.toHaveProperty("archivedAt");
      expect(cols).not.toHaveProperty("archived_at");
    });

    it("enforces primary key on id and not-null on mandatory tenant fields", () => {
      expect(cols.id.primary).toBe(true);
      expect(cols.organizationId.notNull).toBe(true);
      expect(cols.projectId.notNull).toBe(true);
      expect(cols.name.notNull).toBe(true);
      expect(cols.createdBy.notNull).toBe(true);
      expect(cols.createdAt.notNull).toBe(true);
    });
  });

  describe("samples table", () => {
    const cols = getTableColumns(samples);

    it("has exact authoritative fields", () => {
      expect(cols).toHaveProperty("id");
      expect(cols).toHaveProperty("organizationId");
      expect(cols).toHaveProperty("experimentId");
      expect(cols).toHaveProperty("sampleKey");
      expect(cols).toHaveProperty("displayName");
      expect(cols).toHaveProperty("condition");
      expect(cols).toHaveProperty("batch");
      expect(cols).toHaveProperty("biologicalReplicate");
      expect(cols).toHaveProperty("technicalReplicate");
      expect(cols).toHaveProperty("metadataJson");
    });

    it("does not contain speculative fields", () => {
      expect(cols).not.toHaveProperty("createdAt");
      expect(cols).not.toHaveProperty("created_at");
      expect(cols).not.toHaveProperty("updatedAt");
      expect(cols).not.toHaveProperty("updated_at");
    });

    it("enforces primary key on id and not-null on mandatory tenant fields", () => {
      expect(cols.id.primary).toBe(true);
      expect(cols.organizationId.notNull).toBe(true);
      expect(cols.experimentId.notNull).toBe(true);
      expect(cols.sampleKey.notNull).toBe(true);
      expect(cols.metadataJson.notNull).toBe(true);
    });
  });

  describe("datasets table", () => {
    const cols = getTableColumns(datasets);

    it("has exact authoritative fields", () => {
      expect(cols).toHaveProperty("id");
      expect(cols).toHaveProperty("organizationId");
      expect(cols).toHaveProperty("projectId");
      expect(cols).toHaveProperty("name");
      expect(cols).toHaveProperty("description");
      expect(cols).toHaveProperty("status");
      expect(cols).toHaveProperty("createdBy");
      expect(cols).toHaveProperty("createdAt");
    });

    it("does not contain speculative lifecycle fields", () => {
      expect(cols).not.toHaveProperty("updatedAt");
      expect(cols).not.toHaveProperty("updated_at");
      expect(cols).not.toHaveProperty("archivedAt");
      expect(cols).not.toHaveProperty("archived_at");
    });

    it("enforces primary key on id and default active status", () => {
      expect(cols.id.primary).toBe(true);
      expect(cols.organizationId.notNull).toBe(true);
      expect(cols.projectId.notNull).toBe(true);
      expect(cols.name.notNull).toBe(true);
      expect(cols.status.notNull).toBe(true);
      expect(cols.status.default).toBe("active");
    });
  });

  describe("dataset_versions table", () => {
    const cols = getTableColumns(datasetVersions);

    it("has exact authoritative fields", () => {
      expect(cols).toHaveProperty("id");
      expect(cols).toHaveProperty("organizationId");
      expect(cols).toHaveProperty("datasetId");
      expect(cols).toHaveProperty("versionNumber");
      expect(cols).toHaveProperty("sourceFormat");
      expect(cols).toHaveProperty("canonicalFormat");
      expect(cols).toHaveProperty("organism");
      expect(cols).toHaveProperty("geneIdScheme");
      expect(cols).toHaveProperty("referenceBuild");
      expect(cols).toHaveProperty("cellCount");
      expect(cols).toHaveProperty("geneCount");
      expect(cols).toHaveProperty("sourceChecksum");
      expect(cols).toHaveProperty("canonicalChecksum");
      expect(cols).toHaveProperty("createdAt");
    });

    it("ensures Phase 3 scientific metadata fields are nullable", () => {
      expect(cols.canonicalFormat.notNull).toBe(false);
      expect(cols.organism.notNull).toBe(false);
      expect(cols.geneIdScheme.notNull).toBe(false);
      expect(cols.referenceBuild.notNull).toBe(false);
      expect(cols.cellCount.notNull).toBe(false);
      expect(cols.geneCount.notNull).toBe(false);
      expect(cols.sourceChecksum.notNull).toBe(false);
      expect(cols.canonicalChecksum.notNull).toBe(false);
    });

    it("enforces mandatory identity fields", () => {
      expect(cols.id.primary).toBe(true);
      expect(cols.organizationId.notNull).toBe(true);
      expect(cols.datasetId.notNull).toBe(true);
      expect(cols.versionNumber.notNull).toBe(true);
      expect(cols.sourceFormat.notNull).toBe(true);
      expect(cols.createdAt.notNull).toBe(true);
    });
  });

  describe("dataset_files table", () => {
    const cols = getTableColumns(datasetFiles);

    it("has physical verified binding fields only", () => {
      expect(cols).toHaveProperty("id");
      expect(cols).toHaveProperty("organizationId");
      expect(cols).toHaveProperty("datasetVersionId");
      expect(cols).toHaveProperty("r2Key");
      expect(cols).toHaveProperty("byteSize");
      expect(cols).toHaveProperty("fileName");
      expect(cols).toHaveProperty("contentType");
      expect(cols).toHaveProperty("eTag");
      expect(cols).toHaveProperty("createdAt");
    });

    it("does not contain unverified or speculative status/lifecycle fields", () => {
      expect(cols).not.toHaveProperty("status");
      expect(cols).not.toHaveProperty("updatedAt");
      expect(cols).not.toHaveProperty("updated_at");
      expect(cols).not.toHaveProperty("deletedAt");
    });

    it("enforces byteSize bigint and mandatory file coordinates", () => {
      expect(cols.id.primary).toBe(true);
      expect(cols.byteSize.notNull).toBe(true);
      expect(cols.r2Key.notNull).toBe(true);
      expect(cols.fileName.notNull).toBe(true);
      expect(cols.contentType.notNull).toBe(true);
      expect(cols.eTag.notNull).toBe(true);
    });
  });

  describe("upload_sessions table", () => {
    const cols = getTableColumns(uploadSessions);

    it("has exact upload session fields", () => {
      expect(cols).toHaveProperty("id");
      expect(cols).toHaveProperty("organizationId");
      expect(cols).toHaveProperty("projectId");
      expect(cols).toHaveProperty("datasetVersionId");
      expect(cols).toHaveProperty("r2Key");
      expect(cols).toHaveProperty("r2UploadId");
      expect(cols).toHaveProperty("status");
      expect(cols).toHaveProperty("expectedSize");
      expect(cols).toHaveProperty("partSize");
      expect(cols).toHaveProperty("totalParts");
      expect(cols).toHaveProperty("expiresAt");
      expect(cols).toHaveProperty("failureCode");
      expect(cols).toHaveProperty("failureSummary");
      expect(cols).toHaveProperty("createdAt");
      expect(cols).toHaveProperty("updatedAt");
    });

    it("does not persist uploadedParts JSONB (R2 ListParts is authoritative)", () => {
      expect(cols).not.toHaveProperty("uploadedParts");
      expect(cols).not.toHaveProperty("uploaded_parts");
      expect(cols).not.toHaveProperty("parts");
    });

    it("enforces default CREATED status and mandatory sizing metrics", () => {
      expect(cols.id.primary).toBe(true);
      expect(cols.status.default).toBe("CREATED");
      expect(cols.expectedSize.notNull).toBe(true);
      expect(cols.partSize.notNull).toBe(true);
      expect(cols.totalParts.notNull).toBe(true);
      expect(cols.expiresAt.notNull).toBe(true);
    });
  });
});

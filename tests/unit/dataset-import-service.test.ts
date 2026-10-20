import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DatasetImportService,
  type ImportFileInput,
} from "@/server/services/dataset-import-service";
import type { TenantContext } from "@/types";
import {
  ConflictError,
  ResourceNotFoundError,
  ValidationError,
} from "@/server/authorization/errors";
import type { DbClient } from "@/server/database/client";

describe("DatasetImportService (Phase 3 Persistence Boundary)", () => {
  const mockContext: TenantContext = {
    userId: "usr_mock_scientist_1",
    organizationId: "org_alpha_lab",
    role: "scientist",
  };

  const validSha256 = "a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0";

  let mockDb: {
    insert: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
  };
  let service: DatasetImportService;

  beforeEach(() => {
    mockDb = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue([{}]),
      }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      transaction: vi.fn(async (callback) => {
        return callback(mockDb);
      }),
      execute: vi.fn(),
    };

    service = new DatasetImportService({
      dbClient: mockDb as unknown as DbClient,
    });
  });

  describe("registerFileProvenance", () => {
    it("successfully registers file provenance with valid parameters", async () => {
      const result = await service.registerFileProvenance({
        context: mockContext,
        datasetVersionId: "dsv_01940000-0000-7000-8000-000000000001",
        datasetFileId: "dsf_01940000-0000-7000-8000-000000000002",
        uploadSessionId: "upl_01940000-0000-7000-8000-000000000003",
        r2Key: "org/org_alpha_lab/project/prj_1/datasets/dsv_1/raw/matrix.h5ad",
        sha256: validSha256,
        compression: "NONE",
      });

      expect(result.id).toMatch(/^dfp_/);
      expect(result.organizationId).toBe("org_alpha_lab");
      expect(result.sha256).toBe(validSha256);
      expect(result.compression).toBe("NONE");
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it("rejects non-hex or non-64-char sha256 checksums", async () => {
      await expect(
        service.registerFileProvenance({
          context: mockContext,
          datasetVersionId: "dsv_1",
          datasetFileId: "dsf_1",
          uploadSessionId: "upl_1",
          r2Key: "org/raw/matrix.h5ad",
          sha256: "not-a-valid-sha256",
          compression: "NONE",
        })
      ).rejects.toThrow(ValidationError);
    });

    it("rejects invalid compression formats", async () => {
      await expect(
        service.registerFileProvenance({
          context: mockContext,
          datasetVersionId: "dsv_1",
          datasetFileId: "dsf_1",
          uploadSessionId: "upl_1",
          r2Key: "org/raw/matrix.h5ad",
          sha256: validSha256,
          compression: "ZIP" as unknown as "NONE",
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("createImportManifest", () => {
    it("successfully creates manifest for H5AD format with 1 PRIMARY file", async () => {
      // Mock dataset_versions existence check
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "dsv_1",
              organizationId: "org_alpha_lab",
              sourceFormat: "H5AD",
            },
          ]),
        }),
      });

      const files: ImportFileInput[] = [
        {
          datasetFileId: "dsf_primary",
          role: "PRIMARY",
          ordinal: 0,
        },
      ];

      const result = await service.createImportManifest({
        context: mockContext,
        datasetVersionId: "dsv_1",
        sourceFormat: "H5AD",
        sourceChecksum: validSha256,
        files,
      });

      expect(result.id).toMatch(/^dim_/);
      expect(result.organizationId).toBe("org_alpha_lab");
      expect(result.sourceFormat).toBe("H5AD");
      expect(result.files).toHaveLength(1);
      expect(result.files[0]?.id).toMatch(/^dif_/);
      expect(result.files[0]?.role).toBe("PRIMARY");
    });

    it("successfully creates manifest for TENX_MTX format with 3 required files", async () => {
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "dsv_mtx",
              organizationId: "org_alpha_lab",
              sourceFormat: "TENX_MTX",
            },
          ]),
        }),
      });

      const files: ImportFileInput[] = [
        { datasetFileId: "dsf_mat", role: "MATRIX", ordinal: 0 },
        { datasetFileId: "dsf_feat", role: "FEATURES", ordinal: 1 },
        { datasetFileId: "dsf_bar", role: "BARCODES", ordinal: 2 },
      ];

      const result = await service.createImportManifest({
        context: mockContext,
        datasetVersionId: "dsv_mtx",
        sourceFormat: "TENX_MTX",
        sourceChecksum: validSha256,
        files,
      });

      expect(result.sourceFormat).toBe("TENX_MTX");
      expect(result.files).toHaveLength(3);
    });

    it("rejects TENX_MTX format if any of the three required files is missing", async () => {
      const files: ImportFileInput[] = [
        { datasetFileId: "dsf_mat", role: "MATRIX", ordinal: 0 },
        { datasetFileId: "dsf_feat", role: "FEATURES", ordinal: 1 },
      ];

      await expect(
        service.createImportManifest({
          context: mockContext,
          datasetVersionId: "dsv_mtx",
          sourceFormat: "TENX_MTX",
          sourceChecksum: validSha256,
          files,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("rejects H5AD format if more than 1 file is provided", async () => {
      const files: ImportFileInput[] = [
        { datasetFileId: "dsf_1", role: "PRIMARY", ordinal: 0 },
        { datasetFileId: "dsf_2", role: "CELL_METADATA", ordinal: 1 },
      ];

      await expect(
        service.createImportManifest({
          context: mockContext,
          datasetVersionId: "dsv_1",
          sourceFormat: "H5AD",
          sourceChecksum: validSha256,
          files,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("rejects duplicate datasetFileId in manifest input", async () => {
      const files: ImportFileInput[] = [
        { datasetFileId: "dsf_dup", role: "MATRIX", ordinal: 0 },
        { datasetFileId: "dsf_dup", role: "BARCODES", ordinal: 1 },
        { datasetFileId: "dsf_3", role: "FEATURES", ordinal: 2 },
      ];

      await expect(
        service.createImportManifest({
          context: mockContext,
          datasetVersionId: "dsv_1",
          sourceFormat: "TENX_MTX",
          sourceChecksum: validSha256,
          files,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("throws ResourceNotFoundError when dataset version does not exist in tenant", async () => {
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const files: ImportFileInput[] = [{ datasetFileId: "dsf_1", role: "PRIMARY", ordinal: 0 }];

      await expect(
        service.createImportManifest({
          context: mockContext,
          datasetVersionId: "dsv_nonexistent",
          sourceFormat: "H5AD",
          sourceChecksum: validSha256,
          files,
        })
      ).rejects.toThrow(ResourceNotFoundError);
    });

    it("throws ValidationError when version sourceFormat mismatches manifest sourceFormat", async () => {
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "dsv_1",
              organizationId: "org_alpha_lab",
              sourceFormat: "TENX_H5",
            },
          ]),
        }),
      });

      const files: ImportFileInput[] = [{ datasetFileId: "dsf_1", role: "PRIMARY", ordinal: 0 }];

      await expect(
        service.createImportManifest({
          context: mockContext,
          datasetVersionId: "dsv_1",
          sourceFormat: "H5AD",
          sourceChecksum: validSha256,
          files,
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("getImportManifest", () => {
    it("returns null when manifest does not exist", async () => {
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await service.getImportManifest(mockContext, "dsv_none");
      expect(result).toBeNull();
    });

    it("returns manifest with joined files scoped by tenant", async () => {
      mockDb.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                id: "dim_1",
                organizationId: "org_alpha_lab",
                datasetVersionId: "dsv_1",
                sourceFormat: "H5AD",
                sourceChecksum: validSha256,
                createdAt: new Date(),
              },
            ]),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                id: "dif_1",
                organizationId: "org_alpha_lab",
                datasetVersionId: "dsv_1",
                importId: "dim_1",
                datasetFileId: "dsf_1",
                role: "PRIMARY",
                ordinal: 0,
                createdAt: new Date(),
              },
            ]),
          }),
        });

      const result = await service.getImportManifest(mockContext, "dsv_1");
      expect(result).not.toBeNull();
      expect(result?.id).toBe("dim_1");
      expect(result?.files).toHaveLength(1);
      expect(result?.files[0]?.role).toBe("PRIMARY");
    });
  });

  describe("finalizeImport", () => {
    it("successfully calls stored procedure and returns FINALIZED result", async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [
          {
            status: "FINALIZED",
            canonical_artifact_key:
              "org/org_alpha_lab/project/prj_1/datasets/dsv_1/canonical/canonical.h5ad",
            finalized_at: new Date().toISOString(),
          },
        ],
      });

      const result = await service.finalizeImport({
        context: mockContext,
        datasetVersionId: "dsv_1",
        canonicalChecksum: validSha256,
        organism: "Homo sapiens",
        geneIdScheme: "GENE_SYMBOL",
        referenceBuild: "GRCh38",
        cellCount: 2500,
        geneCount: 18000,
      });

      expect(result.status).toBe("FINALIZED");
      expect(result.canonicalArtifactKey).toBe(
        "org/org_alpha_lab/project/prj_1/datasets/dsv_1/canonical/canonical.h5ad"
      );
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("handles idempotent replay (ALREADY_FINALIZED) gracefully", async () => {
      mockDb.execute.mockResolvedValueOnce({
        rows: [
          {
            status: "ALREADY_FINALIZED",
            canonical_artifact_key:
              "org/org_alpha_lab/project/prj_1/datasets/dsv_1/canonical/canonical.h5ad",
            finalized_at: new Date().toISOString(),
          },
        ],
      });

      const result = await service.finalizeImport({
        context: mockContext,
        datasetVersionId: "dsv_1",
        canonicalChecksum: validSha256,
        organism: "Homo sapiens",
        geneIdScheme: "GENE_SYMBOL",
        cellCount: 2500,
        geneCount: 18000,
      });

      expect(result.status).toBe("ALREADY_FINALIZED");
    });

    it("rejects invalid canonical checksum format", async () => {
      await expect(
        service.finalizeImport({
          context: mockContext,
          datasetVersionId: "dsv_1",
          canonicalChecksum: "invalid-checksum",
          organism: "Homo sapiens",
          geneIdScheme: "GENE_SYMBOL",
          cellCount: 2500,
          geneCount: 18000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("rejects non-positive cell or gene counts", async () => {
      await expect(
        service.finalizeImport({
          context: mockContext,
          datasetVersionId: "dsv_1",
          canonicalChecksum: validSha256,
          organism: "Homo sapiens",
          geneIdScheme: "GENE_SYMBOL",
          cellCount: 0,
          geneCount: 18000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("translates DATASET_VERSION_NOT_FOUND to ResourceNotFoundError", async () => {
      mockDb.execute.mockRejectedValueOnce(
        new Error("DATASET_VERSION_NOT_FOUND: version dsv_1 not found in org org_alpha_lab")
      );

      await expect(
        service.finalizeImport({
          context: mockContext,
          datasetVersionId: "dsv_1",
          canonicalChecksum: validSha256,
          organism: "Homo sapiens",
          geneIdScheme: "GENE_SYMBOL",
          cellCount: 2500,
          geneCount: 18000,
        })
      ).rejects.toThrow(ResourceNotFoundError);
    });

    it("translates FINALIZATION_CONFLICT to ConflictError", async () => {
      mockDb.execute.mockRejectedValueOnce(
        new Error(
          "FINALIZATION_CONFLICT: dataset version dsv_1 is already finalized with differing properties"
        )
      );

      await expect(
        service.finalizeImport({
          context: mockContext,
          datasetVersionId: "dsv_1",
          canonicalChecksum: validSha256,
          organism: "Homo sapiens",
          geneIdScheme: "GENE_SYMBOL",
          cellCount: 2500,
          geneCount: 18000,
        })
      ).rejects.toThrow(ConflictError);
    });

    it("translates CARDINALITY_ERROR to ValidationError", async () => {
      mockDb.execute.mockRejectedValueOnce(
        new Error("CARDINALITY_ERROR: H5AD import requires exactly 1 PRIMARY file, found 0")
      );

      await expect(
        service.finalizeImport({
          context: mockContext,
          datasetVersionId: "dsv_1",
          canonicalChecksum: validSha256,
          organism: "Homo sapiens",
          geneIdScheme: "GENE_SYMBOL",
          cellCount: 2500,
          geneCount: 18000,
        })
      ).rejects.toThrow(ValidationError);
    });
  });
});

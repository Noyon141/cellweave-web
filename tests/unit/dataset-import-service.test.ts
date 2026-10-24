import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DatasetImportService,
  type ImportFileInput,
  type SubmitImportFileInput,
  type TrustedChecksumProvider,
  type TrustedChecksumInput,
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
  let mockChecksumProvider: TrustedChecksumProvider;
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

    mockChecksumProvider = {
      computeSourceChecksum: vi
        .fn()
        .mockImplementation((_input: TrustedChecksumInput) => validSha256),
    };

    service = new DatasetImportService({
      testDependencies: {
        dbClient: mockDb as unknown as DbClient,
        checksumProvider: mockChecksumProvider,
      },
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

  describe("submitImportManifest", () => {
    const version = () =>
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { id: "dsv_1", organizationId: "org_alpha_lab", sourceFormat: "H5AD" },
            ]),
        }),
      });
    it("delegates to the trusted provider after validating persisted format", async () => {
      version();
      const files: SubmitImportFileInput[] = [
        { datasetFileId: "dsf_1", role: "PRIMARY", ordinal: 0 },
      ];
      const result = await service.submitImportManifest({
        context: mockContext,
        datasetVersionId: "dsv_1",
        sourceFormat: "H5AD",
        files,
      });
      expect(mockChecksumProvider.computeSourceChecksum).toHaveBeenCalledExactlyOnceWith({
        context: mockContext,
        datasetVersionId: "dsv_1",
        sourceFormat: "H5AD",
        files,
      });
      expect(result.sourceChecksum).toBe(validSha256);
    });
    it("fails closed when the trusted provider rejects missing provenance", async () => {
      version();
      vi.mocked(mockChecksumProvider.computeSourceChecksum).mockRejectedValueOnce(
        new ValidationError("Missing verified physical provenance")
      );
      await expect(
        service.submitImportManifest({
          context: mockContext,
          datasetVersionId: "dsv_1",
          sourceFormat: "H5AD",
          files: [{ datasetFileId: "dsf_1", role: "PRIMARY", ordinal: 0 }],
        })
      ).rejects.toThrow(/Missing verified physical provenance/);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("createTrustedImportManifest & GENERIC_MATRIX Cardinality", () => {
    it("successfully creates manifest for H5AD format with 1 PRIMARY file", async () => {
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
        { datasetFileId: "dsf_primary", role: "PRIMARY", ordinal: 0 },
      ];

      const result = await service.createTrustedImportManifest({
        context: mockContext,
        datasetVersionId: "dsv_1",
        sourceFormat: "H5AD",

        files,
      });

      expect(result.id).toMatch(/^dim_/);
      expect(result.organizationId).toBe("org_alpha_lab");
      expect(result.sourceFormat).toBe("H5AD");
      expect(result.files).toHaveLength(1);
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

      const result = await service.createTrustedImportManifest({
        context: mockContext,
        datasetVersionId: "dsv_mtx",
        sourceFormat: "TENX_MTX",

        files,
      });

      expect(result.sourceFormat).toBe("TENX_MTX");
      expect(result.files).toHaveLength(3);
    });

    describe("GENERIC_MATRIX Cardinality Matrix", () => {
      const setupVersionMock = () => {
        mockDb.select.mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                id: "dsv_generic",
                organizationId: "org_alpha_lab",
                sourceFormat: "GENERIC_MATRIX",
              },
            ]),
          }),
        });
      };

      it("succeeds with MATRIX only", async () => {
        setupVersionMock();
        const files: ImportFileInput[] = [{ datasetFileId: "dsf_m", role: "MATRIX", ordinal: 0 }];
        const res = await service.createTrustedImportManifest({
          context: mockContext,
          datasetVersionId: "dsv_generic",
          sourceFormat: "GENERIC_MATRIX",

          files,
        });
        expect(res.files).toHaveLength(1);
      });

      it("succeeds with MATRIX + CELL_METADATA", async () => {
        setupVersionMock();
        const files: ImportFileInput[] = [
          { datasetFileId: "dsf_m", role: "MATRIX", ordinal: 0 },
          { datasetFileId: "dsf_cm", role: "CELL_METADATA", ordinal: 1 },
        ];
        const res = await service.createTrustedImportManifest({
          context: mockContext,
          datasetVersionId: "dsv_generic",
          sourceFormat: "GENERIC_MATRIX",

          files,
        });
        expect(res.files).toHaveLength(2);
      });

      it("succeeds with MATRIX + FEATURE_METADATA", async () => {
        setupVersionMock();
        const files: ImportFileInput[] = [
          { datasetFileId: "dsf_m", role: "MATRIX", ordinal: 0 },
          { datasetFileId: "dsf_fm", role: "FEATURE_METADATA", ordinal: 1 },
        ];
        const res = await service.createTrustedImportManifest({
          context: mockContext,
          datasetVersionId: "dsv_generic",
          sourceFormat: "GENERIC_MATRIX",

          files,
        });
        expect(res.files).toHaveLength(2);
      });

      it("succeeds with MATRIX + CELL_METADATA + FEATURE_METADATA", async () => {
        setupVersionMock();
        const files: ImportFileInput[] = [
          { datasetFileId: "dsf_m", role: "MATRIX", ordinal: 0 },
          { datasetFileId: "dsf_cm", role: "CELL_METADATA", ordinal: 1 },
          { datasetFileId: "dsf_fm", role: "FEATURE_METADATA", ordinal: 2 },
        ];
        const res = await service.createTrustedImportManifest({
          context: mockContext,
          datasetVersionId: "dsv_generic",
          sourceFormat: "GENERIC_MATRIX",

          files,
        });
        expect(res.files).toHaveLength(3);
      });

      it("rejects 0 MATRIX files", async () => {
        const files: ImportFileInput[] = [
          { datasetFileId: "dsf_cm", role: "CELL_METADATA", ordinal: 0 },
        ];
        await expect(
          service.createTrustedImportManifest({
            context: mockContext,
            datasetVersionId: "dsv_generic",
            sourceFormat: "GENERIC_MATRIX",

            files,
          })
        ).rejects.toThrow(ValidationError);
      });

      it("rejects 2+ MATRIX files", async () => {
        const files: ImportFileInput[] = [
          { datasetFileId: "dsf_m1", role: "MATRIX", ordinal: 0 },
          { datasetFileId: "dsf_m2", role: "MATRIX", ordinal: 1 },
        ];
        await expect(
          service.createTrustedImportManifest({
            context: mockContext,
            datasetVersionId: "dsv_generic",
            sourceFormat: "GENERIC_MATRIX",

            files,
          })
        ).rejects.toThrow(ValidationError);
      });

      it("rejects 2+ CELL_METADATA files", async () => {
        const files: ImportFileInput[] = [
          { datasetFileId: "dsf_m", role: "MATRIX", ordinal: 0 },
          { datasetFileId: "dsf_cm1", role: "CELL_METADATA", ordinal: 1 },
          { datasetFileId: "dsf_cm2", role: "CELL_METADATA", ordinal: 2 },
        ];
        await expect(
          service.createTrustedImportManifest({
            context: mockContext,
            datasetVersionId: "dsv_generic",
            sourceFormat: "GENERIC_MATRIX",

            files,
          })
        ).rejects.toThrow(ValidationError);
      });

      it("rejects 2+ FEATURE_METADATA files", async () => {
        const files: ImportFileInput[] = [
          { datasetFileId: "dsf_m", role: "MATRIX", ordinal: 0 },
          { datasetFileId: "dsf_fm1", role: "FEATURE_METADATA", ordinal: 1 },
          { datasetFileId: "dsf_fm2", role: "FEATURE_METADATA", ordinal: 2 },
        ];
        await expect(
          service.createTrustedImportManifest({
            context: mockContext,
            datasetVersionId: "dsv_generic",
            sourceFormat: "GENERIC_MATRIX",

            files,
          })
        ).rejects.toThrow(ValidationError);
      });

      it("rejects unrelated roles like PRIMARY, FEATURES, or BARCODES in GENERIC_MATRIX", async () => {
        const files: ImportFileInput[] = [
          { datasetFileId: "dsf_m", role: "MATRIX", ordinal: 0 },
          { datasetFileId: "dsf_feat", role: "FEATURES", ordinal: 1 },
        ];
        await expect(
          service.createTrustedImportManifest({
            context: mockContext,
            datasetVersionId: "dsv_generic",
            sourceFormat: "GENERIC_MATRIX",

            files,
          })
        ).rejects.toThrow(ValidationError);
      });
    });

    it("rejects duplicate datasetFileId in manifest input", async () => {
      const files: ImportFileInput[] = [
        { datasetFileId: "dsf_dup", role: "MATRIX", ordinal: 0 },
        { datasetFileId: "dsf_dup", role: "BARCODES", ordinal: 1 },
        { datasetFileId: "dsf_3", role: "FEATURES", ordinal: 2 },
      ];

      await expect(
        service.createTrustedImportManifest({
          context: mockContext,
          datasetVersionId: "dsv_1",
          sourceFormat: "TENX_MTX",

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
        service.createTrustedImportManifest({
          context: mockContext,
          datasetVersionId: "dsv_nonexistent",
          sourceFormat: "H5AD",

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
        service.createTrustedImportManifest({
          context: mockContext,
          datasetVersionId: "dsv_1",
          sourceFormat: "H5AD",

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
    });
  });

  describe("finalizeImport", () => {
    it("successfully calls stored procedure and derives authoritative projectId (where datasetId != projectId)", async () => {
      const expectedCanonicalKey =
        "org/org_alpha_lab/project/prj_authoritative_42/datasets/dsv_test_99/canonical/canonical.h5ad";

      mockDb.execute.mockResolvedValueOnce({
        rows: [
          {
            status: "FINALIZED",
            canonical_artifact_key: expectedCanonicalKey,
            finalized_at: new Date().toISOString(),
          },
        ],
      });

      const result = await service.finalizeImport({
        context: mockContext,
        datasetVersionId: "dsv_test_99",
        canonicalChecksum: validSha256,
        organism: "Homo sapiens",
        geneIdScheme: "GENE_SYMBOL",
        referenceBuild: "GRCh38",
        cellCount: 2500,
        geneCount: 18000,
      });

      expect(result.status).toBe("FINALIZED");
      expect(result.canonicalArtifactKey).toBe(expectedCanonicalKey);
      expect(result.canonicalArtifactKey).toContain("project/prj_authoritative_42/");
      expect(result.canonicalArtifactKey).not.toContain("project/ds_test_99/");
      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("handles idempotent replay (ALREADY_FINALIZED) gracefully without duplicate mutation", async () => {
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

    describe("Idempotent Replay Rejection per Mutable Field", () => {
      const testCases = [
        {
          field: "canonicalChecksum",
          error:
            "FINALIZATION_CONFLICT: dataset version dsv_1 is already finalized with differing properties",
        },
        {
          field: "organism",
          error:
            "FINALIZATION_CONFLICT: dataset version dsv_1 is already finalized with differing properties",
        },
        {
          field: "geneIdScheme",
          error:
            "FINALIZATION_CONFLICT: dataset version dsv_1 is already finalized with differing properties",
        },
        {
          field: "referenceBuild",
          error:
            "FINALIZATION_CONFLICT: dataset version dsv_1 is already finalized with differing properties",
        },
        {
          field: "cellCount",
          error:
            "FINALIZATION_CONFLICT: dataset version dsv_1 is already finalized with differing properties",
        },
        {
          field: "geneCount",
          error:
            "FINALIZATION_CONFLICT: dataset version dsv_1 is already finalized with differing properties",
        },
      ];

      it.each(testCases)("rejects conflicting replay when $field differs", async ({ error }) => {
        mockDb.execute.mockRejectedValueOnce(new Error(error));

        await expect(
          service.finalizeImport({
            context: mockContext,
            datasetVersionId: "dsv_1",
            canonicalChecksum: validSha256,
            organism: "Homo sapiens",
            geneIdScheme: "GENE_SYMBOL",
            referenceBuild: "GRCh38",
            cellCount: 2500,
            geneCount: 18000,
          })
        ).rejects.toThrow(ConflictError);
      });
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

    it("translates CARDINALITY_ERROR to ValidationError", async () => {
      mockDb.execute.mockRejectedValueOnce(
        new Error(
          "CARDINALITY_ERROR: GENERIC_MATRIX import requires exactly 1 MATRIX file, at most 1 CELL_METADATA, at most 1 FEATURE_METADATA, and no other roles"
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
      ).rejects.toThrow(ValidationError);
    });

    it("translates INCOMPLETE_PROVENANCE to ValidationError", async () => {
      mockDb.execute.mockRejectedValueOnce(
        new Error("INCOMPLETE_PROVENANCE: 2 files in manifest but 1 have verified provenance")
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

    it("translates UPLOAD_SESSION_STATE_CONFLICT to ConflictError", async () => {
      mockDb.execute.mockRejectedValueOnce(
        new Error(
          "UPLOAD_SESSION_STATE_CONFLICT: expected 1 verified upload sessions to mark IMPORTED, but updated 0"
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
  });
});

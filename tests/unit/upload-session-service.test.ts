import { describe, it, expect, vi } from "vitest";
import { UploadSessionService, calculatePartPlan } from "@/server/services/upload-session-service";
import {
  TenantAuthorizationError,
  ConflictError,
  ValidationError,
} from "@/server/authorization/errors";
import { StorageError, type StorageService } from "@/server/integrations/storage/storage-types";
import type { TenantContext, OrganizationRole } from "@/types";
import type { DbClient } from "@/server/database/client";

function makeContext(
  role: OrganizationRole,
  orgId = "org_alpha",
  userId = "usr_actor"
): TenantContext {
  return {
    organizationId: orgId,
    userId,
    role,
  };
}

function createMockStorageService(overrides: Partial<StorageService> = {}): StorageService {
  return {
    createMultipartUpload: vi.fn().mockResolvedValue({
      uploadId: "mock_r2_upload_id_123",
      objectKey: "mock_key",
    }),
    createPresignedUploadPartUrl: vi
      .fn()
      .mockResolvedValue("https://r2.mock/upload-part?signed=true"),
    listMultipartParts: vi.fn().mockResolvedValue([]),
    completeMultipartUpload: vi.fn().mockResolvedValue({
      objectKey: "mock_key",
      eTag: "mock_final_etag",
      location: "https://r2.mock/completed",
    }),
    abortMultipartUpload: vi.fn().mockResolvedValue(undefined),
    headObject: vi.fn().mockResolvedValue({
      objectKey: "mock_key",
      contentLength: 25 * 1024 * 1024,
      eTag: "mock_head_etag",
      contentType: "application/octet-stream",
    }),
    createPresignedDownloadUrl: vi.fn().mockResolvedValue("https://r2.mock/download?signed=true"),
    ...overrides,
  };
}

describe("UploadSessionService Unit Tests", () => {
  describe("calculatePartPlan", () => {
    it("computes default 10 MiB parts for typical dataset sizes", () => {
      // 25 MiB with default 10 MiB part size -> 3 parts (10 MiB, 10 MiB, 5 MiB)
      const plan = calculatePartPlan(25 * 1024 * 1024);
      expect(plan.partSize).toBe(10 * 1024 * 1024);
      expect(plan.totalParts).toBe(3);
    });

    it("computes single part for file smaller than part size", () => {
      const plan = calculatePartPlan(1024 * 1024); // 1 MiB
      expect(plan.partSize).toBe(10 * 1024 * 1024);
      expect(plan.totalParts).toBe(1);
    });

    it("accepts custom part size within S3 protocol bounds (5 MiB to 5 GiB)", () => {
      const plan = calculatePartPlan(50 * 1024 * 1024, 5 * 1024 * 1024);
      expect(plan.partSize).toBe(5 * 1024 * 1024);
      expect(plan.totalParts).toBe(10);
    });

    it("automatically scales up part size when total parts would exceed 10,000", () => {
      // 200 GiB with default 10 MiB part size would be 20,480 parts (> 10,000)
      const bigSize = 200 * 1024 * 1024 * 1024;
      const plan = calculatePartPlan(bigSize);
      expect(plan.totalParts).toBeLessThanOrEqual(10_000);
      expect(plan.partSize).toBeGreaterThan(10 * 1024 * 1024);
      // Part size must be multiple of 5 MiB
      expect(plan.partSize % (5 * 1024 * 1024)).toBe(0);
    });

    it("rejects invalid, negative, zero, or non-integer expectedSize", () => {
      expect(() => calculatePartPlan(0)).toThrow(ValidationError);
      expect(() => calculatePartPlan(-100)).toThrow(ValidationError);
      expect(() => calculatePartPlan(12.34)).toThrow(ValidationError);
      expect(() => calculatePartPlan(NaN)).toThrow(ValidationError);
    });

    it("rejects size exceeding 5 TiB maximum object limit", () => {
      const over5TiB = 6 * 1024 * 1024 * 1024 * 1024;
      expect(() => calculatePartPlan(over5TiB)).toThrow(ValidationError);
    });

    it("rejects custom part size smaller than 5 MiB or greater than 5 GiB", () => {
      expect(() => calculatePartPlan(100 * 1024 * 1024, 1024 * 1024)).toThrow(ValidationError);
      expect(() => calculatePartPlan(100 * 1024 * 1024, 6 * 1024 * 1024 * 1024)).toThrow(
        ValidationError
      );
    });
  });

  describe("initiateUpload", () => {
    it("viewer role is strictly rejected from initiating uploads", async () => {
      const service = new UploadSessionService();
      const ctx = makeContext("viewer");

      await expect(
        service.initiateUpload(ctx, {
          datasetVersionId: "dsv_123",
          fileName: "matrix.h5ad",
          expectedSize: 20 * 1024 * 1024,
          contentType: "application/octet-stream",
        })
      ).rejects.toThrow(TenantAuthorizationError);
    });

    it("owner, admin, bioinformatician, scientist can initiate uploads", async () => {
      for (const role of ["owner", "admin", "bioinformatician", "scientist"] as const) {
        const mockDb = {
          select: vi.fn().mockImplementation(() => ({
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([
                    {
                      versionId: "dsv_0192e123",
                      datasetId: "ds_0192e123",
                      projectId: "prj_0192e123",
                      projectStatus: "active",
                      projectArchivedAt: null,
                    },
                  ]),
                }),
              }),
              where: vi.fn().mockResolvedValue([]), // no existing active upload session
            }),
          })),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockImplementation((vals: Record<string, unknown>) => ({
              returning: vi.fn().mockResolvedValue([
                {
                  ...vals,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              ]),
            })),
          }),
        } as unknown as DbClient;

        const mockAudit = {
          recordUserAuditEvent: vi.fn().mockResolvedValue({}),
        };

        const mockPerm = {
          assertProjectAccess: vi.fn().mockResolvedValue(undefined),
        };

        const mockStorage = createMockStorageService({
          createMultipartUpload: vi.fn().mockResolvedValue({
            uploadId: "r2_up_123",
            objectKey:
              "org/org_alpha/project/prj_0192e123/datasets/dsv_0192e123/source/matrix.h5ad",
          }),
        });

        const service = new UploadSessionService({
          dbClient: mockDb,
          auditService:
            mockAudit as unknown as import("@/server/services/audit-service").AuditService,
          permissionService:
            mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
          storageService: mockStorage,
        });

        const ctx = makeContext(role);
        const session = await service.initiateUpload(ctx, {
          datasetVersionId: "dsv_0192e123",
          fileName: "matrix.h5ad",
          expectedSize: 25 * 1024 * 1024,
          contentType: "application/octet-stream",
        });

        expect(session.id).toMatch(/^upl_/);
        expect(session.status).toBe("CREATED");
        expect(session.totalParts).toBe(3);
        expect(mockStorage.createMultipartUpload).toHaveBeenCalledWith(
          expect.objectContaining({
            objectKey:
              "org/org_alpha/project/prj_0192e123/datasets/dsv_0192e123/source/matrix.h5ad",
          })
        );
        expect(mockAudit.recordUserAuditEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "upload.initiated",
            resourceType: "upload_session",
            resourceId: session.id,
          })
        );
      }
    });

    it("rejects initiation when parent project is archived", async () => {
      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([
                  {
                    versionId: "dsv_123",
                    datasetId: "ds_123",
                    projectId: "prj_archived",
                    projectStatus: "archived",
                    projectArchivedAt: new Date(),
                  },
                ]),
              }),
            }),
          }),
        }),
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
      });

      const ctx = makeContext("owner");
      await expect(
        service.initiateUpload(ctx, {
          datasetVersionId: "dsv_123",
          fileName: "test.h5ad",
          expectedSize: 10 * 1024 * 1024,
          contentType: "application/octet-stream",
        })
      ).rejects.toThrow("Cannot upload files to an archived project");
    });

    it("rejects initiation when an active unexpired upload session already exists for the file", async () => {
      const mockDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([
                  {
                    versionId: "dsv_123",
                    datasetId: "ds_123",
                    projectId: "prj_123",
                    projectStatus: "active",
                    projectArchivedAt: null,
                  },
                ]),
              }),
            }),
            where: vi.fn().mockResolvedValue([
              {
                id: "upl_existing_active",
                status: "UPLOADING",
                expiresAt: new Date(Date.now() + 600000), // unexpired
              },
            ]),
          }),
        })),
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
      });

      const ctx = makeContext("scientist");
      await expect(
        service.initiateUpload(ctx, {
          datasetVersionId: "dsv_123",
          fileName: "counts.mtx.gz",
          expectedSize: 20 * 1024 * 1024,
          contentType: "application/gzip",
        })
      ).rejects.toThrow(ConflictError);
    });

    it("triggers compensating abortMultipartUpload if database insertion fails", async () => {
      const mockStorage = createMockStorageService({
        createMultipartUpload: vi.fn().mockResolvedValue({
          uploadId: "r2_orphaned_upload_id",
          objectKey: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        }),
        abortMultipartUpload: vi.fn().mockResolvedValue(undefined),
      });

      const mockDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([
                  {
                    versionId: "dsv_123",
                    datasetId: "ds_123",
                    projectId: "prj_123",
                    projectStatus: "active",
                    projectArchivedAt: null,
                  },
                ]),
              }),
            }),
            where: vi.fn().mockResolvedValue([]),
          }),
        })),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(new Error("Simulated DB connection failure")),
          }),
        }),
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
      });

      const ctx = makeContext("owner");
      await expect(
        service.initiateUpload(ctx, {
          datasetVersionId: "dsv_123",
          fileName: "data.h5ad",
          expectedSize: 15 * 1024 * 1024,
          contentType: "application/octet-stream",
        })
      ).rejects.toThrow("Simulated DB connection failure");

      // Verify compensating action executed
      expect(mockStorage.abortMultipartUpload).toHaveBeenCalledWith({
        objectKey: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        uploadId: "r2_orphaned_upload_id",
      });
    });
  });

  describe("getResumeState", () => {
    it("returns uploaded and missing parts based on authoritative R2 state", async () => {
      const sessionRow = {
        id: "upl_resume_123",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "UPLOADING",
        expectedSize: 30 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 3,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      // Parts 1 and 3 uploaded, part 2 missing
      const mockStorage = createMockStorageService({
        listMultipartParts: vi.fn().mockResolvedValue([
          { partNumber: 1, eTag: "etag_part_1", sizeBytes: 10 * 1024 * 1024 },
          { partNumber: 3, eTag: "etag_part_3", sizeBytes: 10 * 1024 * 1024 },
        ]),
      });

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
      });

      const ctx = makeContext("scientist");
      const resume = await service.getResumeState(ctx, "upl_resume_123");

      expect(resume.sessionId).toBe("upl_resume_123");
      expect(resume.totalParts).toBe(3);
      expect(resume.uploadedParts).toHaveLength(2);
      expect(resume.missingParts).toEqual([2]);
    });

    it("reconciles if R2 returns NoSuchUpload but object already exists at expected size", async () => {
      const sessionRow = {
        id: "upl_reconcile_123",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "UPLOADING",
        expectedSize: 20 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 2,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const mockStorage = createMockStorageService({
        listMultipartParts: vi
          .fn()
          .mockRejectedValue(
            new StorageError("Multipart upload not found", "MULTIPART_UPLOAD_NOT_FOUND")
          ),
        headObject: vi.fn().mockResolvedValue({
          objectKey: sessionRow.r2Key,
          contentLength: 20 * 1024 * 1024, // matches expectedSize
          eTag: "assembled_etag",
        }),
      });

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
      });

      const ctx = makeContext("scientist");
      const resume = await service.getResumeState(ctx, "upl_reconcile_123");

      expect(resume.status).toBe("VERIFYING");
      expect(resume.missingParts).toEqual([]);
    });
  });

  describe("createPartUploadUrls", () => {
    it("viewer role cannot generate upload URLs", async () => {
      const service = new UploadSessionService();
      const ctx = makeContext("viewer");

      await expect(
        service.createPartUploadUrls(ctx, {
          sessionId: "upl_123",
          partNumbers: [1, 2],
        })
      ).rejects.toThrow(TenantAuthorizationError);
    });

    it("rejects part numbers out of session bounds", async () => {
      const sessionRow = {
        id: "upl_bounds_123",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "CREATED",
        expectedSize: 20 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 2,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      let selectCount = 0;
      const mockDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(async () => {
              selectCount++;
              if (selectCount === 1) return [sessionRow];
              return [{ status: "active", archivedAt: null }];
            }),
          }),
        })),
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
      });

      const ctx = makeContext("bioinformatician");
      await expect(
        service.createPartUploadUrls(ctx, {
          sessionId: "upl_bounds_123",
          partNumbers: [1, 3], // 3 is out of bounds (totalParts = 2)
        })
      ).rejects.toThrow("out of bounds");
    });

    it("deduplicates requested part numbers and transitions CREATED to UPLOADING", async () => {
      const sessionRow = {
        id: "upl_created_123",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "CREATED",
        expectedSize: 30 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 3,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const projectRow = {
        status: "active",
        archivedAt: null,
      };

      let selectCallCount = 0;
      const mockDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(async () => {
              selectCallCount++;
              if (selectCallCount === 1) return [sessionRow];
              return [projectRow];
            }),
          }),
        })),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const mockStorage = createMockStorageService();

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
      });

      const ctx = makeContext("admin");
      // Requesting [1, 2, 1, 2] should deduplicate to [1, 2]
      const urls = await service.createPartUploadUrls(ctx, {
        sessionId: "upl_created_123",
        partNumbers: [1, 2, 1, 2],
      });

      expect(urls).toHaveLength(2);
      expect(urls[0]?.partNumber).toBe(1);
      expect(urls[1]?.partNumber).toBe(2);
      expect(mockStorage.createPresignedUploadPartUrl).toHaveBeenCalledTimes(2);
      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe("completeUpload", () => {
    it("rejects completion if required parts are missing in R2", async () => {
      const sessionRow = {
        id: "upl_comp_incomplete",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "UPLOADING",
        expectedSize: 30 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 3,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      // Only part 1 uploaded, parts 2 and 3 missing
      const mockStorage = createMockStorageService({
        listMultipartParts: vi.fn().mockResolvedValue([{ partNumber: 1, eTag: "p1" }]),
      });

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
      });

      const ctx = makeContext("owner");
      await expect(service.completeUpload(ctx, "upl_comp_incomplete")).rejects.toThrow(
        "missing 2 parts [2, 3]"
      );
    });

    it("short-circuits idempotently if session is already VERIFIED", async () => {
      const sessionRow = {
        id: "upl_comp_already_verified",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "VERIFIED",
        expectedSize: 10 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 1,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const fileRow = {
        id: "dsf_existing_123",
        organizationId: "org_alpha",
        datasetVersionId: "dsv_123",
        r2Key: sessionRow.r2Key,
        byteSize: 10 * 1024 * 1024,
        fileName: "data.h5ad",
        contentType: "application/octet-stream",
        eTag: "existing_etag",
        createdAt: new Date(),
      };

      let selectCount = 0;
      const mockDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(async () => {
              selectCount++;
              if (selectCount === 1) return [sessionRow];
              return [fileRow];
            }),
          }),
        })),
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const mockStorage = createMockStorageService();
      const mockAudit = { recordUserAuditEvent: vi.fn() };

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
        auditService:
          mockAudit as unknown as import("@/server/services/audit-service").AuditService,
      });

      const ctx = makeContext("admin");
      const result = await service.completeUpload(ctx, "upl_comp_already_verified");

      expect(result.session.status).toBe("VERIFIED");
      expect(result.file.id).toBe("dsf_existing_123");
      // R2 completeMultipartUpload must NOT be called again
      expect(mockStorage.completeMultipartUpload).not.toHaveBeenCalled();
      // No duplicate audit event recorded
      expect(mockAudit.recordUserAuditEvent).not.toHaveBeenCalled();
    });

    it("verifies size and binds dataset_file in transaction upon valid completion", async () => {
      const sessionRow = {
        id: "upl_comp_success",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "UPLOADING",
        expectedSize: 20 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 2,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ ...sessionRow, status: "VERIFIED" }]),
            }),
          }),
        }),
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
          const txMock = {
            insert: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnValue({
                onConflictDoNothing: vi.fn().mockReturnValue({
                  returning: vi.fn().mockResolvedValue([
                    {
                      id: "dsf_new_456",
                      organizationId: "org_alpha",
                      datasetVersionId: "dsv_123",
                      r2Key: sessionRow.r2Key,
                      byteSize: 20 * 1024 * 1024,
                      fileName: "data.h5ad",
                      contentType: "application/octet-stream",
                      eTag: "final_etag",
                      createdAt: new Date(),
                    },
                  ]),
                }),
              }),
            }),
            update: vi.fn().mockReturnValue({
              set: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  returning: vi.fn().mockResolvedValue([{ ...sessionRow, status: "VERIFIED" }]),
                }),
              }),
            }),
          };
          return cb(txMock);
        },
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const mockAudit = {
        recordUserAuditEvent: vi.fn().mockResolvedValue({}),
      };

      const mockStorage = createMockStorageService({
        listMultipartParts: vi.fn().mockResolvedValue([
          { partNumber: 1, eTag: "p1" },
          { partNumber: 2, eTag: "p2" },
        ]),
        completeMultipartUpload: vi.fn().mockResolvedValue({
          objectKey: sessionRow.r2Key,
          eTag: "final_etag",
        }),
        headObject: vi.fn().mockResolvedValue({
          objectKey: sessionRow.r2Key,
          contentLength: 20 * 1024 * 1024, // matches expectedSize
          eTag: "final_etag",
          contentType: "application/octet-stream",
        }),
      });

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
        auditService:
          mockAudit as unknown as import("@/server/services/audit-service").AuditService,
      });

      const ctx = makeContext("scientist");
      const result = await service.completeUpload(ctx, "upl_comp_success");

      expect(result.session.status).toBe("VERIFIED");
      expect(result.file.id).toBe("dsf_new_456");
      expect(mockStorage.completeMultipartUpload).toHaveBeenCalled();
      expect(mockAudit.recordUserAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "upload.completed",
          resourceType: "upload_session",
          resourceId: "upl_comp_success",
        })
      );
    });

    it("rejects and marks session FAILED if object size does not match expected size", async () => {
      const sessionRow = {
        id: "upl_comp_mismatch",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "UPLOADING",
        expectedSize: 20 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 2,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const mockStorage = createMockStorageService({
        listMultipartParts: vi.fn().mockResolvedValue([
          { partNumber: 1, eTag: "p1" },
          { partNumber: 2, eTag: "p2" },
        ]),
        completeMultipartUpload: vi.fn().mockResolvedValue({
          objectKey: sessionRow.r2Key,
          eTag: "final_etag",
        }),
        headObject: vi.fn().mockResolvedValue({
          objectKey: sessionRow.r2Key,
          contentLength: 15 * 1024 * 1024, // mismatch: expected 20 MiB
          eTag: "final_etag",
        }),
      });

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
      });

      const ctx = makeContext("owner");
      await expect(service.completeUpload(ctx, "upl_comp_mismatch")).rejects.toThrow(
        ValidationError
      );
      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe("abortUpload", () => {
    it("viewer role cannot abort upload sessions", async () => {
      const service = new UploadSessionService();
      const ctx = makeContext("viewer");

      await expect(service.abortUpload(ctx, "upl_123")).rejects.toThrow(TenantAuthorizationError);
    });

    it("aborts active upload session in R2 and PostgreSQL, recording audit event", async () => {
      const sessionRow = {
        id: "upl_abort_123",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "UPLOADING",
        expectedSize: 20 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 2,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ ...sessionRow, status: "ABORTED" }]),
            }),
          }),
        }),
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const mockAudit = {
        recordUserAuditEvent: vi.fn().mockResolvedValue({}),
      };

      const mockStorage = createMockStorageService();

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
        auditService:
          mockAudit as unknown as import("@/server/services/audit-service").AuditService,
      });

      const ctx = makeContext("scientist");
      const aborted = await service.abortUpload(ctx, "upl_abort_123");

      expect(aborted.status).toBe("ABORTED");
      expect(mockStorage.abortMultipartUpload).toHaveBeenCalledWith({
        objectKey: sessionRow.r2Key,
        uploadId: sessionRow.r2UploadId,
      });
      expect(mockAudit.recordUserAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "upload.aborted",
          resourceType: "upload_session",
          resourceId: "upl_abort_123",
        })
      );
    });

    it("idempotently returns already ABORTED session", async () => {
      const sessionRow = {
        id: "upl_already_aborted",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "ABORTED",
        expectedSize: 20 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 2,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const mockStorage = createMockStorageService();

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
      });

      const ctx = makeContext("admin");
      const result = await service.abortUpload(ctx, "upl_already_aborted");
      expect(result.status).toBe("ABORTED");
      expect(mockStorage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it("cannot abort an already VERIFIED upload session", async () => {
      const sessionRow = {
        id: "upl_verified_123",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "VERIFIED",
        expectedSize: 20 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 2,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
      });

      const ctx = makeContext("owner");
      await expect(service.abortUpload(ctx, "upl_verified_123")).rejects.toThrow(
        "Cannot abort an upload session that has already been verified"
      );
    });
  });
});

import { describe, it, expect, vi } from "vitest";
import { UploadSessionService, calculatePartPlan } from "@/server/services/upload-session-service";
import {
  TenantAuthorizationError,
  ConflictError,
  ValidationError,
  IntegrityError,
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

describe("UploadSessionService Unit Tests (Phase 2 Step G Hardened)", () => {
  describe("calculatePartPlan", () => {
    it("computes default 10 MiB parts for typical dataset sizes", () => {
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
      const bigSize = 200 * 1024 * 1024 * 1024;
      const plan = calculatePartPlan(bigSize);
      expect(plan.totalParts).toBeLessThanOrEqual(10_000);
      expect(plan.partSize).toBeGreaterThan(10 * 1024 * 1024);
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
              where: vi.fn().mockResolvedValue([]),
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
                expiresAt: new Date(Date.now() + 600000),
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

      expect(mockStorage.abortMultipartUpload).toHaveBeenCalledWith({
        objectKey: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        uploadId: "r2_orphaned_upload_id",
      });
    });

    it("Section 10: demonstrates duplicate active session concurrency behavior", async () => {
      // Simulating concurrent execution where both select queries execute before either inserts
      let selectCount = 0;
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
            where: vi.fn().mockImplementation(async () => {
              selectCount++;
              // Both concurrent callers see no active session
              return [];
            }),
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

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const mockStorage = createMockStorageService();
      const mockAudit = { recordUserAuditEvent: vi.fn().mockResolvedValue({}) };

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
        auditService:
          mockAudit as unknown as import("@/server/services/audit-service").AuditService,
      });

      const ctx = makeContext("owner");

      // Concurrent invocation
      const [res1, res2] = await Promise.all([
        service.initiateUpload(ctx, {
          datasetVersionId: "dsv_123",
          fileName: "concurrent.h5ad",
          expectedSize: 20 * 1024 * 1024,
          contentType: "application/octet-stream",
        }),
        service.initiateUpload(ctx, {
          datasetVersionId: "dsv_123",
          fileName: "concurrent.h5ad",
          expectedSize: 20 * 1024 * 1024,
          contentType: "application/octet-stream",
        }),
      ]);

      // Both succeeded under application-level check only; documents the race condition
      expect(res1.id).not.toBe(res2.id);
      expect(selectCount).toBe(2);
    });
  });

  describe("completeUpload Canonical State Machine & Failure Modes", () => {
    it("Section 2: executes strict canonical state transitions UPLOADING -> UPLOADED -> VERIFYING without skipping", async () => {
      const sessionRow = {
        id: "upl_lifecycle_test",
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

      const updatedStatuses: string[] = [];

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation((setValues: { status: string }) => {
            updatedStatuses.push(setValues.status);
            return {
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ ...sessionRow, status: setValues.status }]),
              }),
            };
          }),
        })),
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
          const txMock = {
            select: vi.fn().mockReturnValue({
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([]),
              }),
            }),
            insert: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([
                  {
                    id: "dsf_lifecycle_123",
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
            update: vi.fn().mockReturnValue({
              set: vi.fn().mockImplementation((setValues: { status: string }) => {
                updatedStatuses.push(setValues.status);
                return {
                  where: vi.fn().mockReturnValue({
                    returning: vi
                      .fn()
                      .mockResolvedValue([{ ...sessionRow, status: setValues.status }]),
                  }),
                };
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
          contentLength: 20 * 1024 * 1024,
          eTag: "final_etag",
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
      const result = await service.completeUpload(ctx, "upl_lifecycle_test");

      expect(result.session.status).toBe("VERIFIED");
      // Must prove state machine did not skip UPLOADED: UPLOADED -> VERIFYING -> VERIFIED
      expect(updatedStatuses).toContain("UPLOADED");
      expect(updatedStatuses).toContain("VERIFYING");
      expect(updatedStatuses).toContain("VERIFIED");
      expect(updatedStatuses.indexOf("UPLOADED")).toBeLessThan(
        updatedStatuses.indexOf("VERIFYING")
      );
      expect(updatedStatuses.indexOf("VERIFYING")).toBeLessThan(
        updatedStatuses.indexOf("VERIFIED")
      );
    });

    it("Section 3: completeUpload called from CREATED steps through UPLOADING -> UPLOADED -> VERIFYING", async () => {
      const sessionRow = {
        id: "upl_from_created",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "CREATED",
        expectedSize: 10 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 1,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updatedStatuses: string[] = [];

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation((setValues: { status: string }) => {
            updatedStatuses.push(setValues.status);
            return {
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ ...sessionRow, status: setValues.status }]),
              }),
            };
          }),
        })),
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
          const txMock = {
            select: vi.fn().mockReturnValue({
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([]),
              }),
            }),
            insert: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([
                  {
                    id: "dsf_created_123",
                    organizationId: "org_alpha",
                    datasetVersionId: "dsv_123",
                    r2Key: sessionRow.r2Key,
                    byteSize: 10 * 1024 * 1024,
                    fileName: "data.h5ad",
                    contentType: "application/octet-stream",
                    eTag: "final_etag",
                    createdAt: new Date(),
                  },
                ]),
              }),
            }),
            update: vi.fn().mockImplementation(() => ({
              set: vi.fn().mockImplementation((setValues: { status: string }) => {
                updatedStatuses.push(setValues.status);
                return {
                  where: vi.fn().mockReturnValue({
                    returning: vi
                      .fn()
                      .mockResolvedValue([{ ...sessionRow, status: setValues.status }]),
                  }),
                };
              }),
            })),
          };
          return cb(txMock);
        },
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const mockStorage = createMockStorageService({
        listMultipartParts: vi.fn().mockResolvedValue([{ partNumber: 1, eTag: "p1" }]),
        completeMultipartUpload: vi.fn().mockResolvedValue({
          objectKey: sessionRow.r2Key,
          eTag: "final_etag",
        }),
        headObject: vi.fn().mockResolvedValue({
          objectKey: sessionRow.r2Key,
          contentLength: 10 * 1024 * 1024,
          eTag: "final_etag",
        }),
      });

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
        auditService: {
          recordUserAuditEvent: vi.fn().mockResolvedValue({}),
        } as unknown as import("@/server/services/audit-service").AuditService,
      });

      const ctx = makeContext("owner");
      const result = await service.completeUpload(ctx, "upl_from_created");

      expect(result.session.status).toBe("VERIFIED");
      expect(updatedStatuses).toEqual(["UPLOADING", "UPLOADED", "VERIFYING", "VERIFIED"]);
    });

    it("Section 3: completeUpload called from CREATED with missing parts returns incomplete error without mutating to VERIFYING", async () => {
      const sessionRow = {
        id: "upl_created_no_parts",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "CREATED",
        expectedSize: 10 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 1,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updatedStatuses: string[] = [];

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation((setValues: { status: string }) => {
            updatedStatuses.push(setValues.status);
            return {
              where: vi.fn().mockResolvedValue([]),
            };
          }),
        })),
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      // No parts uploaded in R2
      const mockStorage = createMockStorageService({
        listMultipartParts: vi.fn().mockResolvedValue([]),
      });

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
      });

      const ctx = makeContext("owner");
      await expect(service.completeUpload(ctx, "upl_created_no_parts")).rejects.toThrow(
        "missing 1 parts [1]"
      );

      // Must never have mutated to VERIFYING or UPLOADED
      expect(updatedStatuses).not.toContain("VERIFYING");
      expect(updatedStatuses).not.toContain("UPLOADED");
    });

    it("Section 4: dataset_files conflict reconciliation detects matching binding and reconciles idempotently", async () => {
      const sessionRow = {
        id: "upl_reconcile_match",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "VERIFYING",
        expectedSize: 10 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 1,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const existingMatchingFile = {
        id: "dsf_already_bound",
        organizationId: "org_alpha",
        datasetVersionId: "dsv_123",
        r2Key: sessionRow.r2Key,
        byteSize: 10 * 1024 * 1024,
        fileName: "data.h5ad",
        contentType: "application/octet-stream",
        eTag: "final_etag",
        createdAt: new Date(),
      };

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
          const txMock = {
            select: vi.fn().mockReturnValue({
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([existingMatchingFile]),
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

      const mockStorage = createMockStorageService({
        headObject: vi.fn().mockResolvedValue({
          objectKey: sessionRow.r2Key,
          contentLength: 10 * 1024 * 1024,
          eTag: "final_etag",
          contentType: "application/octet-stream",
        }),
      });

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
        auditService: {
          recordUserAuditEvent: vi.fn().mockResolvedValue({}),
        } as unknown as import("@/server/services/audit-service").AuditService,
      });

      const ctx = makeContext("owner");
      const result = await service.completeUpload(ctx, "upl_reconcile_match");

      expect(result.session.status).toBe("VERIFIED");
      expect(result.file.id).toBe("dsf_already_bound");
    });

    it("Section 4: dataset_files conflict reconciliation raises IntegrityError when existing row has mismatched size", async () => {
      const sessionRow = {
        id: "upl_integrity_mismatch",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "VERIFYING",
        expectedSize: 20 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 2,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const conflictingCorruptFile = {
        id: "dsf_corrupt_binding",
        organizationId: "org_alpha",
        datasetVersionId: "dsv_123",
        r2Key: sessionRow.r2Key,
        byteSize: 5 * 1024 * 1024, // Mismatched size!
        fileName: "data.h5ad",
        contentType: "application/octet-stream",
        eTag: "different_etag",
        createdAt: new Date(),
      };

      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
          const txMock = {
            select: vi.fn().mockReturnValue({
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([conflictingCorruptFile]),
              }),
            }),
          };
          return cb(txMock);
        },
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const mockStorage = createMockStorageService({
        headObject: vi.fn().mockResolvedValue({
          objectKey: sessionRow.r2Key,
          contentLength: 20 * 1024 * 1024,
          eTag: "valid_etag",
        }),
      });

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
      });

      const ctx = makeContext("owner");
      await expect(service.completeUpload(ctx, "upl_integrity_mismatch")).rejects.toThrow(
        IntegrityError
      );
    });

    it("Section 5: audit idempotency guarantees exactly one upload.completed audit event on retries", async () => {
      const sessionRow = {
        id: "upl_audit_idempotent",
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
        id: "dsf_audit_idempotent",
        organizationId: "org_alpha",
        datasetVersionId: "dsv_123",
        r2Key: sessionRow.r2Key,
        byteSize: 10 * 1024 * 1024,
        fileName: "data.h5ad",
        contentType: "application/octet-stream",
        eTag: "final_etag",
        createdAt: new Date(),
      };

      let selectCount = 0;
      const mockDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(async () => {
              selectCount++;
              if (selectCount % 2 === 1) return [sessionRow];
              return [fileRow];
            }),
          }),
        })),
      } as unknown as DbClient;

      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue(undefined),
      };

      const mockAudit = { recordUserAuditEvent: vi.fn() };
      const mockStorage = createMockStorageService();

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
        auditService:
          mockAudit as unknown as import("@/server/services/audit-service").AuditService,
      });

      const ctx = makeContext("owner");
      // Execute 3 retries
      await service.completeUpload(ctx, "upl_audit_idempotent");
      await service.completeUpload(ctx, "upl_audit_idempotent");
      await service.completeUpload(ctx, "upl_audit_idempotent");

      // Exactly zero additional audit events logged during retries on already VERIFIED
      expect(mockAudit.recordUserAuditEvent).not.toHaveBeenCalled();
    });

    it("Section 11: CompleteMultipartUpload succeeds in R2, DB fails on attempt 1, retry reconciles into VERIFIED with 1 audit event", async () => {
      const sessionRow = {
        id: "upl_r2_success_db_fail",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "UPLOADING",
        expectedSize: 10 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 1,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      let attempt = 1;
      const mockDb = {
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockReturnValue({
            where: vi
              .fn()
              .mockResolvedValue([
                attempt === 1 ? sessionRow : { ...sessionRow, status: "VERIFYING" },
              ]),
          }),
        })),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ ...sessionRow, status: "VERIFYING" }]),
            }),
          }),
        }),
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
          if (attempt === 1) {
            // Simulated crash / connection failure after R2 completion
            throw new Error("Simulated Neon DB transaction abort on attempt 1");
          }
          const txMock = {
            select: vi.fn().mockReturnValue({
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([]),
              }),
            }),
            insert: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([
                  {
                    id: "dsf_reconciled_123",
                    organizationId: "org_alpha",
                    datasetVersionId: "dsv_123",
                    r2Key: sessionRow.r2Key,
                    byteSize: 10 * 1024 * 1024,
                    fileName: "data.h5ad",
                    contentType: "application/octet-stream",
                    eTag: "final_etag",
                    createdAt: new Date(),
                  },
                ]),
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

      const mockAudit = { recordUserAuditEvent: vi.fn().mockResolvedValue({}) };

      const mockStorage = createMockStorageService({
        listMultipartParts: vi.fn().mockImplementation(async () => {
          if (attempt === 1) return [{ partNumber: 1, eTag: "p1" }];
          // After R2 completed on attempt 1, listMultipartParts returns NoSuchUpload
          throw new StorageError("Multipart upload not found", "MULTIPART_UPLOAD_NOT_FOUND");
        }),
        completeMultipartUpload: vi.fn().mockResolvedValue({
          objectKey: sessionRow.r2Key,
          eTag: "final_etag",
        }),
        headObject: vi.fn().mockResolvedValue({
          objectKey: sessionRow.r2Key,
          contentLength: 10 * 1024 * 1024,
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

      const ctx = makeContext("owner");

      // Attempt 1 fails during DB commit
      await expect(service.completeUpload(ctx, "upl_r2_success_db_fail")).rejects.toThrow(
        "Simulated Neon DB transaction abort on attempt 1"
      );

      // Attempt 2 succeeds via HeadObject reconciliation in VERIFYING state
      attempt = 2;
      const result = await service.completeUpload(ctx, "upl_r2_success_db_fail");

      expect(result.session.status).toBe("VERIFIED");
      expect(result.file.id).toBe("dsf_reconciled_123");
      // Exactly 1 completion audit event logged
      expect(mockAudit.recordUserAuditEvent).toHaveBeenCalledTimes(1);
      expect(mockAudit.recordUserAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "upload.completed",
          resourceId: "upl_r2_success_db_fail",
        })
      );
    });

    it("Section 12: CompleteMultipartUpload -> MULTIPART_UPLOAD_NOT_FOUND reconciles via HeadObject", async () => {
      const sessionRow = {
        id: "upl_nosuchupload_comp",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "UPLOADING",
        expectedSize: 10 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 1,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockPerm = { assertProjectAccess: vi.fn().mockResolvedValue(undefined) };

      // Case A: HeadObject exists with exact size -> reconciles to VERIFIED
      const mockStorageA = createMockStorageService({
        listMultipartParts: vi
          .fn()
          .mockRejectedValue(new StorageError("NoSuchUpload", "MULTIPART_UPLOAD_NOT_FOUND")),
        headObject: vi.fn().mockResolvedValue({
          objectKey: sessionRow.r2Key,
          contentLength: 10 * 1024 * 1024,
          eTag: "final_etag",
        }),
      });

      const mockDbA = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ ...sessionRow, status: "VERIFYING" }]),
            }),
          }),
        }),
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
          const txMock = {
            select: vi.fn().mockReturnValue({
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([]),
              }),
            }),
            insert: vi.fn().mockReturnValue({
              values: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([
                  {
                    id: "dsf_reconciled_a",
                    organizationId: "org_alpha",
                    datasetVersionId: "dsv_123",
                    r2Key: sessionRow.r2Key,
                    byteSize: 10 * 1024 * 1024,
                    fileName: "data.h5ad",
                    contentType: "application/octet-stream",
                    eTag: "final_etag",
                    createdAt: new Date(),
                  },
                ]),
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

      const serviceA = new UploadSessionService({
        dbClient: mockDbA,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorageA,
        auditService: {
          recordUserAuditEvent: vi.fn().mockResolvedValue({}),
        } as unknown as import("@/server/services/audit-service").AuditService,
      });

      const resA = await serviceA.completeUpload(makeContext("owner"), "upl_nosuchupload_comp");
      expect(resA.session.status).toBe("VERIFIED");

      // Case B: HeadObject absent -> safe terminal failure
      const mockStorageB = createMockStorageService({
        listMultipartParts: vi
          .fn()
          .mockRejectedValue(new StorageError("NoSuchUpload", "MULTIPART_UPLOAD_NOT_FOUND")),
        headObject: vi.fn().mockResolvedValue(null),
      });

      const mockDbB = {
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

      const serviceB = new UploadSessionService({
        dbClient: mockDbB,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorageB,
      });

      await expect(
        serviceB.completeUpload(makeContext("owner"), "upl_nosuchupload_comp")
      ).rejects.toThrow(ValidationError);
      expect(mockDbB.update).toHaveBeenCalled();
    });

    it("Section 9: retryable provider error (PROVIDER_UNAVAILABLE) leaves session in VERIFYING without marking FAILED", async () => {
      const sessionRow = {
        id: "upl_transient_error",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "VERIFYING",
        expectedSize: 10 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 1,
        expiresAt: new Date(Date.now() + 3600000),
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updatedStatuses: string[] = [];
      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation((setVals: { status: string }) => {
            updatedStatuses.push(setVals.status);
            return {
              where: vi.fn().mockResolvedValue([]),
            };
          }),
        })),
      } as unknown as DbClient;

      const mockPerm = { assertProjectAccess: vi.fn().mockResolvedValue(undefined) };

      // Provider throws retryable 503 Service Unavailable
      const mockStorage = createMockStorageService({
        headObject: vi
          .fn()
          .mockRejectedValue(new StorageError("Service Unavailable", "PROVIDER_UNAVAILABLE", true)),
      });

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
      });

      await expect(
        service.completeUpload(makeContext("owner"), "upl_transient_error")
      ).rejects.toThrow("Service Unavailable");

      // Must NOT have transitioned to FAILED
      expect(updatedStatuses).not.toContain("FAILED");
    });
  });

  describe("abortUpload & expiry Hardened Rules", () => {
    it("Section 7: rejects client abort while status is VERIFYING if object already exists in storage", async () => {
      const sessionRow = {
        id: "upl_verifying_abort",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "VERIFYING",
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

      const mockPerm = { assertProjectAccess: vi.fn().mockResolvedValue(undefined) };

      // HeadObject shows object is already completed in R2
      const mockStorage = createMockStorageService({
        headObject: vi.fn().mockResolvedValue({
          objectKey: sessionRow.r2Key,
          contentLength: 20 * 1024 * 1024,
          eTag: "completed_etag",
        }),
      });

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
      });

      const ctx = makeContext("owner");
      await expect(service.abortUpload(ctx, "upl_verifying_abort")).rejects.toThrow(ConflictError);
      // Blind abort in R2 must NOT have been called
      expect(mockStorage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it("Section 6: abortUpload with NoSuchUpload rejects abort if completed object exists (completion race)", async () => {
      const sessionRow = {
        id: "upl_nosuchupload_abort",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "UPLOADING",
        expectedSize: 10 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 1,
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

      const mockPerm = { assertProjectAccess: vi.fn().mockResolvedValue(undefined) };

      const mockStorage = createMockStorageService({
        abortMultipartUpload: vi
          .fn()
          .mockRejectedValue(new StorageError("NoSuchUpload", "MULTIPART_UPLOAD_NOT_FOUND")),
        headObject: vi.fn().mockResolvedValue({
          objectKey: sessionRow.r2Key,
          contentLength: 10 * 1024 * 1024,
          eTag: "completed_etag",
        }),
      });

      const service = new UploadSessionService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
        storageService: mockStorage,
      });

      const ctx = makeContext("owner");
      await expect(service.abortUpload(ctx, "upl_nosuchupload_abort")).rejects.toThrow(
        ConflictError
      );
    });

    it("Section 8: expireUploadSession leaves session recoverable if completed object exists", async () => {
      const sessionRow = {
        id: "upl_expire_test",
        organizationId: "org_alpha",
        projectId: "prj_123",
        datasetVersionId: "dsv_123",
        r2Key: "org/org_alpha/project/prj_123/datasets/dsv_123/source/data.h5ad",
        r2UploadId: "r2_upload_abc",
        status: "UPLOADING",
        expectedSize: 15 * 1024 * 1024,
        partSize: 10 * 1024 * 1024,
        totalParts: 2,
        expiresAt: new Date(Date.now() - 1000), // Expired
        failureCode: null,
        failureSummary: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updatedStatuses: string[] = [];
      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([sessionRow]),
          }),
        }),
        update: vi.fn().mockImplementation(() => ({
          set: vi.fn().mockImplementation((setVals: { status: string }) => {
            updatedStatuses.push(setVals.status);
            return {
              where: vi.fn().mockResolvedValue([]),
            };
          }),
        })),
      } as unknown as DbClient;

      // HeadObject shows completed object
      const mockStorage = createMockStorageService({
        headObject: vi.fn().mockResolvedValue({
          objectKey: sessionRow.r2Key,
          contentLength: 15 * 1024 * 1024,
          eTag: "completed_etag",
        }),
      });

      const service = new UploadSessionService({
        dbClient: mockDb,
        storageService: mockStorage,
      });

      await service.expireUploadSession("upl_expire_test", "org_alpha");

      // Must NOT be marked EXPIRED; transitioned to VERIFYING for recovery
      expect(updatedStatuses).toContain("VERIFYING");
      expect(updatedStatuses).not.toContain("EXPIRED");
    });
  });
});

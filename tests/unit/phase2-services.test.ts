import { describe, it, expect, vi } from "vitest";
import { ProjectService } from "@/server/services/project-service";
import { ExperimentService } from "@/server/services/experiment-service";
import { SampleService } from "@/server/services/sample-service";
import { DatasetService } from "@/server/services/dataset-service";
import {
  TenantAuthorizationError,
  ConflictError,
  ValidationError,
} from "@/server/authorization/errors";
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

describe("Phase 2 Application Services Unit Tests", () => {
  describe("ProjectService", () => {
    describe("Authorization & Role Matrix", () => {
      it("owner and admin can create projects", async () => {
        for (const role of ["owner", "admin"] as const) {
          const mockDb = {
            transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
            insert: () => ({
              values: (vals: Record<string, unknown>) => ({
                returning: () =>
                  Promise.resolve([
                    {
                      id: vals.id,
                      organizationId: vals.organizationId,
                      name: vals.name,
                      description: vals.description,
                      status: vals.status,
                      createdBy: vals.createdBy,
                      createdAt: vals.createdAt,
                      updatedAt: vals.updatedAt,
                      archivedAt: vals.archivedAt,
                    },
                  ]),
              }),
            }),
          } as unknown as DbClient;

          const mockAudit = {
            recordUserAuditEvent: vi.fn().mockResolvedValue({}),
          };

          const service = new ProjectService({
            dbClient: mockDb,
            auditService:
              mockAudit as unknown as import("@/server/services/audit-service").AuditService,
          });

          const ctx = makeContext(role);
          const project = await service.createProject(ctx, { name: "Project Alpha" });

          expect(project.id).toMatch(/^prj_/);
          expect(project.name).toBe("Project Alpha");
          expect(mockAudit.recordUserAuditEvent).toHaveBeenCalledWith(
            expect.objectContaining({
              action: "project.created",
              resourceType: "project",
              resourceId: project.id,
            })
          );
        }
      });

      it("bioinformatician, scientist, and viewer are denied project creation", async () => {
        for (const role of ["bioinformatician", "scientist", "viewer"] as const) {
          const service = new ProjectService({});
          const ctx = makeContext(role);

          await expect(service.createProject(ctx, { name: "Forbidden" })).rejects.toThrow(
            TenantAuthorizationError
          );
        }
      });

      it("rejects invalid project input", async () => {
        const service = new ProjectService({});
        const ctx = makeContext("owner");

        await expect(service.createProject(ctx, { name: "" })).rejects.toThrow(ValidationError);
      });

      it("rejects modifying an archived project", async () => {
        const mockDb = {
          transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
          select: () => ({
            from: () => ({
              where: () =>
                Promise.resolve([
                  {
                    id: "prj_archived",
                    organizationId: "org_alpha",
                    name: "Old Project",
                    status: "archived",
                    archivedAt: new Date(),
                  },
                ]),
            }),
          }),
        } as unknown as DbClient;

        const service = new ProjectService({ dbClient: mockDb });
        const ctx = makeContext("owner");

        await expect(
          service.updateProject(ctx, "prj_archived", { name: "New Name" })
        ).rejects.toThrow(ValidationError);
      });

      it("rejects re-archiving an already archived project", async () => {
        const mockDb = {
          transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
          select: () => ({
            from: () => ({
              where: () =>
                Promise.resolve([
                  {
                    id: "prj_archived",
                    organizationId: "org_alpha",
                    name: "Old Project",
                    status: "archived",
                    archivedAt: new Date(),
                  },
                ]),
            }),
          }),
        } as unknown as DbClient;

        const service = new ProjectService({ dbClient: mockDb });
        const ctx = makeContext("owner");

        await expect(service.archiveProject(ctx, "prj_archived")).rejects.toThrow(ValidationError);
      });
    });
  });

  describe("ExperimentService", () => {
    it("viewer role cannot create or update experiments", async () => {
      const service = new ExperimentService({});
      const ctx = makeContext("viewer");

      await expect(service.createExperiment(ctx, "prj_1", { name: "Exp 1" })).rejects.toThrow(
        TenantAuthorizationError
      );

      await expect(
        service.updateExperiment(ctx, "exp_1", { name: "Exp 1 Updated" })
      ).rejects.toThrow(TenantAuthorizationError);
    });

    it("rejects creating experiment in an archived project", async () => {
      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue({ hasAccess: true }),
      };

      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () =>
              Promise.resolve([
                {
                  status: "archived",
                  archivedAt: new Date(),
                },
              ]),
          }),
        }),
      } as unknown as DbClient;

      const service = new ExperimentService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
      });

      const ctx = makeContext("scientist");

      await expect(
        service.createExperiment(ctx, "prj_archived", { name: "Exp in Archived" })
      ).rejects.toThrow(ValidationError);
    });

    it("creates experiment with UUIDv7 ID and records audit event", async () => {
      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue({ hasAccess: true }),
      };

      const mockAudit = {
        recordUserAuditEvent: vi.fn().mockResolvedValue({}),
      };

      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () =>
              Promise.resolve([
                {
                  status: "active",
                  archivedAt: null,
                },
              ]),
          }),
        }),
        insert: () => ({
          values: (vals: Record<string, unknown>) => ({
            returning: () =>
              Promise.resolve([
                {
                  ...vals,
                  createdAt: new Date(),
                },
              ]),
          }),
        }),
      } as unknown as DbClient;

      const service = new ExperimentService({
        dbClient: mockDb,
        auditService:
          mockAudit as unknown as import("@/server/services/audit-service").AuditService,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
      });

      const ctx = makeContext("bioinformatician");
      const exp = await service.createExperiment(ctx, "prj_active", {
        name: "RNA-seq 1",
        organism: "Homo sapiens",
        tissue: "Blood",
      });

      expect(exp.id).toMatch(/^exp_[0-9a-f-]+/);
      expect(exp.name).toBe("RNA-seq 1");
      expect(exp.organism).toBe("Homo sapiens");
      expect(mockAudit.recordUserAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "experiment.created",
          resourceType: "experiment",
          resourceId: exp.id,
        })
      );
    });
  });

  describe("SampleService", () => {
    it("viewer role cannot create or update samples", async () => {
      const service = new SampleService({});
      const ctx = makeContext("viewer");

      await expect(service.createSample(ctx, "exp_1", { sampleKey: "sample_01" })).rejects.toThrow(
        TenantAuthorizationError
      );

      await expect(service.updateSample(ctx, "smp_1", { condition: "control" })).rejects.toThrow(
        TenantAuthorizationError
      );
    });

    it("rejects invalid sampleKey format", async () => {
      const service = new SampleService({});
      const ctx = makeContext("scientist");

      await expect(
        service.createSample(ctx, "exp_1", { sampleKey: "invalid space key" })
      ).rejects.toThrow(ValidationError);
    });

    it("rejects duplicate sampleKey within the same experiment with ConflictError", async () => {
      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue({ hasAccess: true }),
      };

      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () =>
                Promise.resolve([
                  {
                    id: "exp_1",
                    projectId: "prj_1",
                    projectStatus: "active",
                    projectArchivedAt: null,
                  },
                ]),
            }),
            where: () => {
              // Second select checks sampleKey duplicate
              return Promise.resolve([{ id: "smp_existing" }]);
            },
          }),
        }),
      } as unknown as DbClient;

      const service = new SampleService({
        dbClient: mockDb,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
      });

      const ctx = makeContext("scientist");

      await expect(service.createSample(ctx, "exp_1", { sampleKey: "sample_01" })).rejects.toThrow(
        ConflictError
      );
    });
  });

  describe("DatasetService", () => {
    it("viewer role cannot create datasets or dataset versions", async () => {
      const service = new DatasetService({});
      const ctx = makeContext("viewer");

      await expect(service.createDataset(ctx, "prj_1", { name: "DS 1" })).rejects.toThrow(
        TenantAuthorizationError
      );

      await expect(
        service.createDatasetVersion(ctx, "ds_1", { sourceFormat: "10x_h5" })
      ).rejects.toThrow(TenantAuthorizationError);
    });

    it("allocates monotonic version number starting from 1 when no previous versions exist", async () => {
      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue({ hasAccess: true }),
      };

      const mockAudit = {
        recordUserAuditEvent: vi.fn().mockResolvedValue({}),
      };

      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => ({
              for: () =>
                Promise.resolve([
                  {
                    id: "ds_1",
                    projectId: "prj_1",
                    status: "active",
                  },
                ]),
              then: (resolve: (val: unknown) => void) =>
                resolve([
                  {
                    status: "active",
                    archivedAt: null,
                  },
                ]),
            }),
          }),
        }),
        insert: () => ({
          values: (vals: Record<string, unknown>) => ({
            returning: () =>
              Promise.resolve([
                {
                  ...vals,
                  createdAt: new Date(),
                },
              ]),
          }),
        }),
      } as unknown as DbClient;

      const service = new DatasetService({
        dbClient: mockDb,
        auditService:
          mockAudit as unknown as import("@/server/services/audit-service").AuditService,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
      });

      // Override select to return proper sequence for parent dataset, parent project, and max version
      let callCount = 0;
      (mockDb as unknown as { select: () => unknown }).select = () => ({
        from: () => ({
          where: () => {
            callCount++;
            if (callCount === 1) {
              // 1. SELECT dataset FOR UPDATE
              return {
                for: () =>
                  Promise.resolve([
                    {
                      id: "ds_1",
                      projectId: "prj_1",
                      status: "active",
                    },
                  ]),
              };
            }
            if (callCount === 2) {
              // 2. SELECT project
              return Promise.resolve([
                {
                  status: "active",
                  archivedAt: null,
                },
              ]);
            }
            // 3. SELECT MAX(version_number)
            return Promise.resolve([{ maxVersion: 0 }]);
          },
        }),
      });

      const ctx = makeContext("scientist");
      const dsv = await service.createDatasetVersion(ctx, "ds_1", {
        sourceFormat: "10x_h5",
        organism: "Mus musculus",
      });

      expect(dsv.id).toMatch(/^dsv_[0-9a-f-]+/);
      expect(dsv.versionNumber).toBe(1);
      expect(dsv.sourceFormat).toBe("10x_h5");
      expect(mockAudit.recordUserAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "dataset_version.created",
          resourceType: "dataset_version",
          resourceId: dsv.id,
        })
      );
    });

    it("increments max version number correctly when previous versions exist", async () => {
      const mockPerm = {
        assertProjectAccess: vi.fn().mockResolvedValue({ hasAccess: true }),
      };

      const mockAudit = {
        recordUserAuditEvent: vi.fn().mockResolvedValue({}),
      };

      let callCount = 0;
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => {
              callCount++;
              if (callCount === 1) {
                return {
                  for: () =>
                    Promise.resolve([
                      {
                        id: "ds_1",
                        projectId: "prj_1",
                        status: "active",
                      },
                    ]),
                };
              }
              if (callCount === 2) {
                return Promise.resolve([
                  {
                    status: "active",
                    archivedAt: null,
                  },
                ]);
              }
              // Previous max version was 3
              return Promise.resolve([{ maxVersion: 3 }]);
            },
          }),
        }),
        insert: () => ({
          values: (vals: Record<string, unknown>) => ({
            returning: () =>
              Promise.resolve([
                {
                  ...vals,
                  createdAt: new Date(),
                },
              ]),
          }),
        }),
      } as unknown as DbClient;

      const service = new DatasetService({
        dbClient: mockDb,
        auditService:
          mockAudit as unknown as import("@/server/services/audit-service").AuditService,
        permissionService:
          mockPerm as unknown as import("@/server/services/project-permission-service").ProjectPermissionService,
      });

      const ctx = makeContext("bioinformatician");
      const dsv = await service.createDatasetVersion(ctx, "ds_1", {
        sourceFormat: "anndata_h5ad",
      });

      expect(dsv.versionNumber).toBe(4);
    });
  });
});

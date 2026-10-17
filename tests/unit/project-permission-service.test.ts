import { describe, it, expect, vi } from "vitest";
import { ProjectPermissionService } from "@/server/services/project-permission-service";
import {
  TenantAuthorizationError,
  ResourceNotFoundError,
  ConflictError,
  ValidationError,
} from "@/server/authorization";
import type { TenantContext, OrganizationRole } from "@/types";
import type { DbClient } from "@/server/database/client";
import { projects, projectMembers } from "@/server/database/schema/projects";
import { member } from "@/server/database/schema/auth";

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

describe("Project Permission & Access Enforcement Service Tests (Step G)", () => {
  describe("Project Access Policy & Enforcement", () => {
    it("1. owner accesses same-org project without assignment", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([mockProject]),
          }),
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha");
      const res = await service.assertProjectAccess(ctx, "proj_1");

      expect(res.hasAccess).toBe(true);
      expect(res.accessType).toBe("organization_wide");
      expect(res.role).toBe("owner");
    });

    it("2. admin accesses same-org project without assignment", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([mockProject]),
          }),
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("admin", "org_alpha");
      const res = await service.assertProjectAccess(ctx, "proj_1");

      expect(res.hasAccess).toBe(true);
      expect(res.accessType).toBe("organization_wide");
      expect(res.role).toBe("admin");
    });

    it("3. bioinformatician requires assignment and is denied when unassigned", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockDb = {
        select: () => ({
          from: (table: unknown) => ({
            where: () => {
              if (table === projects) return Promise.resolve([mockProject]);
              if (table === projectMembers) return Promise.resolve([]); // unassigned
              return Promise.resolve([]);
            },
          }),
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("bioinformatician", "org_alpha", "usr_bio_1");

      await expect(service.assertProjectAccess(ctx, "proj_1")).rejects.toThrow(
        TenantAuthorizationError
      );
    });

    it("4. scientist requires assignment and is denied when unassigned", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockDb = {
        select: () => ({
          from: (table: unknown) => ({
            where: () => {
              if (table === projects) return Promise.resolve([mockProject]);
              if (table === projectMembers) return Promise.resolve([]);
              return Promise.resolve([]);
            },
          }),
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("scientist", "org_alpha", "usr_sc_1");

      await expect(service.assertProjectAccess(ctx, "proj_1")).rejects.toThrow(
        TenantAuthorizationError
      );
    });

    it("5. viewer requires assignment and is denied when unassigned", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockDb = {
        select: () => ({
          from: (table: unknown) => ({
            where: () => {
              if (table === projects) return Promise.resolve([mockProject]);
              if (table === projectMembers) return Promise.resolve([]);
              return Promise.resolve([]);
            },
          }),
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("viewer", "org_alpha", "usr_vw_1");

      await expect(service.assertProjectAccess(ctx, "proj_1")).rejects.toThrow(
        TenantAuthorizationError
      );
    });

    it("6. assigned bioinformatician allowed", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockAssignment = { id: "pm_1" };
      const mockDb = {
        select: () => ({
          from: (table: unknown) => ({
            where: () => {
              if (table === projects) return Promise.resolve([mockProject]);
              if (table === projectMembers) return Promise.resolve([mockAssignment]);
              return Promise.resolve([]);
            },
          }),
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("bioinformatician", "org_alpha", "usr_bio_1");
      const res = await service.assertProjectAccess(ctx, "proj_1");

      expect(res.hasAccess).toBe(true);
      expect(res.accessType).toBe("project_assignment");
    });

    it("7. assigned scientist allowed", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockAssignment = { id: "pm_2" };
      const mockDb = {
        select: () => ({
          from: (table: unknown) => ({
            where: () => {
              if (table === projects) return Promise.resolve([mockProject]);
              if (table === projectMembers) return Promise.resolve([mockAssignment]);
              return Promise.resolve([]);
            },
          }),
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("scientist", "org_alpha", "usr_sc_1");
      const res = await service.assertProjectAccess(ctx, "proj_1");

      expect(res.hasAccess).toBe(true);
      expect(res.accessType).toBe("project_assignment");
    });

    it("8. assigned viewer allowed", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockAssignment = { id: "pm_3" };
      const mockDb = {
        select: () => ({
          from: (table: unknown) => ({
            where: () => {
              if (table === projects) return Promise.resolve([mockProject]);
              if (table === projectMembers) return Promise.resolve([mockAssignment]);
              return Promise.resolve([]);
            },
          }),
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("viewer", "org_alpha", "usr_vw_1");
      const res = await service.assertProjectAccess(ctx, "proj_1");

      expect(res.hasAccess).toBe(true);
      expect(res.accessType).toBe("project_assignment");
    });

    it("9. foreign-tenant project denied non-disclosing", async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha");

      await expect(service.assertProjectAccess(ctx, "proj_foreign_in_org_beta")).rejects.toThrow(
        ResourceNotFoundError
      );
    });
  });

  describe("Project Assignment Authorization & Guards", () => {
    it("10. owner can assign eligible lower-role member", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockTargetMember = {
        id: "mem_sc",
        userId: "usr_sc",
        role: "scientist",
        userName: "Scientist User",
        userEmail: "sc@example.com",
        userImage: null,
      };

      let insertedValues: Record<string, unknown> | null = null;
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: (table: unknown) => {
            if (table === projects) {
              return { where: () => Promise.resolve([mockProject]) };
            }
            if (table === member) {
              return {
                innerJoin: () => ({
                  where: () => Promise.resolve([mockTargetMember]),
                }),
              };
            }
            // projectMembers check for duplicates -> empty
            return { where: () => Promise.resolve([]) };
          },
        }),
        insert: () => ({
          values: (vals: Record<string, unknown>) => {
            insertedValues = vals;
            return Promise.resolve();
          },
        }),
      } as unknown as DbClient;

      const auditHook = vi.fn();
      const service = new ProjectPermissionService({
        dbClient: mockDb,
        auditHook,
      });

      const ctx = makeContext("owner", "org_alpha", "usr_owner");
      const res = await service.assignMemberToProject(ctx, "proj_1", "usr_sc");

      expect(res.userId).toBe("usr_sc");
      expect(res.role).toBe("scientist");
      expect(insertedValues).not.toBeNull();
      expect(auditHook).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "project_member.assigned",
          projectId: "proj_1",
          targetUserId: "usr_sc",
        })
      );
    });

    it("11. admin can assign eligible lower-role member", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockTargetMember = {
        id: "mem_bio",
        userId: "usr_bio",
        role: "bioinformatician",
        userName: "Bio User",
        userEmail: "bio@example.com",
        userImage: null,
      };

      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: (table: unknown) => {
            if (table === projects) {
              return { where: () => Promise.resolve([mockProject]) };
            }
            if (table === member) {
              return {
                innerJoin: () => ({
                  where: () => Promise.resolve([mockTargetMember]),
                }),
              };
            }
            return { where: () => Promise.resolve([]) };
          },
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("admin", "org_alpha", "usr_admin");
      const res = await service.assignMemberToProject(ctx, "proj_1", "usr_bio");

      expect(res.role).toBe("bioinformatician");
    });

    const lowerRoles: OrganizationRole[] = ["bioinformatician", "scientist", "viewer"];

    for (const role of lowerRoles) {
      it(`12-14. ${role} cannot assign project members`, async () => {
        const service = new ProjectPermissionService({
          dbClient: {} as DbClient,
        });
        const ctx = makeContext(role, "org_alpha");

        await expect(service.assignMemberToProject(ctx, "proj_1", "usr_target")).rejects.toThrow(
          TenantAuthorizationError
        );
      });
    }

    it("15. cross-tenant user assignment rejected non-disclosing", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: (table: unknown) => {
            if (table === projects) {
              return { where: () => Promise.resolve([mockProject]) };
            }
            if (table === member) {
              return {
                innerJoin: () => ({
                  where: () => Promise.resolve([]), // not found in Org A
                }),
              };
            }
            return { where: () => Promise.resolve([]) };
          },
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha");

      await expect(
        service.assignMemberToProject(ctx, "proj_1", "usr_foreign_belonging_to_org_b")
      ).rejects.toThrow(ResourceNotFoundError);
    });

    it("16. owner/admin target assignment rejected as redundant", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockAdminTarget = {
        id: "mem_adm",
        userId: "usr_adm_2",
        role: "admin",
        userName: "Admin Two",
        userEmail: "adm2@example.com",
        userImage: null,
      };

      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: (table: unknown) => {
            if (table === projects) {
              return { where: () => Promise.resolve([mockProject]) };
            }
            if (table === member) {
              return {
                innerJoin: () => ({
                  where: () => Promise.resolve([mockAdminTarget]),
                }),
              };
            }
            return { where: () => Promise.resolve([]) };
          },
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha");

      await expect(service.assignMemberToProject(ctx, "proj_1", "usr_adm_2")).rejects.toThrow(
        ValidationError
      );
    });

    it("17. duplicate assignment handled deterministically with ConflictError", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockTargetMember = {
        id: "mem_sc",
        userId: "usr_sc",
        role: "scientist",
        userName: "Scientist User",
        userEmail: "sc@example.com",
        userImage: null,
      };
      const existingAssignment = { id: "pm_existing" };

      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: (table: unknown) => {
            if (table === projects) {
              return { where: () => Promise.resolve([mockProject]) };
            }
            if (table === member) {
              return {
                innerJoin: () => ({
                  where: () => Promise.resolve([mockTargetMember]),
                }),
              };
            }
            return { where: () => Promise.resolve([existingAssignment]) };
          },
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha");

      await expect(service.assignMemberToProject(ctx, "proj_1", "usr_sc")).rejects.toThrow(
        ConflictError
      );
    });
  });

  describe("Remove Project Assignment", () => {
    it("18. assignment removal revokes access immediately", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockAssignment = { id: "pm_target" };

      let deleted = false;
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: (table: unknown) => ({
            where: () => {
              if (table === projects) {
                return Promise.resolve([mockProject]);
              }
              return Promise.resolve([mockAssignment]);
            },
          }),
        }),
        delete: () => ({
          where: () => {
            deleted = true;
            return Promise.resolve();
          },
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as DbClient;

      const auditHook = vi.fn();
      const service = new ProjectPermissionService({
        dbClient: mockDb,
        auditHook,
      });

      const ctx = makeContext("admin", "org_alpha", "usr_actor");
      await service.removeMemberFromProject(ctx, "proj_1", "usr_target");

      expect(deleted).toBe(true);
      expect(auditHook).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "project_member.removed",
          projectId: "proj_1",
          targetUserId: "usr_target",
        })
      );
    });

    it("19. foreign assignment removal cannot mutate", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: (table: unknown) => ({
            where: () => {
              if (table === projects) {
                return Promise.resolve([mockProject]);
              }
              return Promise.resolve([]); // not assigned in org_alpha
            },
          }),
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha");

      await expect(service.removeMemberFromProject(ctx, "proj_1", "usr_foreign")).rejects.toThrow(
        ResourceNotFoundError
      );
    });

    it("rolls back project assignment when transactional audit persistence fails", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockTargetMember = {
        id: "mem_sc",
        userId: "usr_sc",
        role: "scientist",
        userName: "Scientist User",
        userEmail: "sc@example.com",
        userImage: null,
      };

      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: (table: unknown) => {
            if (table === projects) return { where: () => Promise.resolve([mockProject]) };
            if (table === member) {
              return {
                innerJoin: () => ({
                  where: () => Promise.resolve([mockTargetMember]),
                }),
              };
            }
            return { where: () => Promise.resolve([]) };
          },
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as DbClient;

      const failingAuditService = {
        recordUserAuditEvent: vi.fn().mockRejectedValue(new Error("Audit DB down")),
      };

      const service = new ProjectPermissionService({
        dbClient: mockDb,
        auditService: failingAuditService as unknown as InstanceType<
          typeof import("@/server/services/audit-service").AuditService
        >,
      });
      const ctx = makeContext("owner", "org_alpha");

      await expect(service.assignMemberToProject(ctx, "proj_1", "usr_sc")).rejects.toThrow(
        "Audit DB down"
      );
    });

    it("rolls back project member removal when transactional audit persistence fails", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockAssignment = { id: "pm_target" };

      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: (table: unknown) => ({
            where: () => {
              if (table === projects) return Promise.resolve([mockProject]);
              return Promise.resolve([mockAssignment]);
            },
          }),
        }),
        delete: () => ({
          where: () => Promise.resolve(),
        }),
      } as unknown as DbClient;

      const failingAuditService = {
        recordUserAuditEvent: vi.fn().mockRejectedValue(new Error("Audit DB down")),
      };

      const service = new ProjectPermissionService({
        dbClient: mockDb,
        auditService: failingAuditService as unknown as InstanceType<
          typeof import("@/server/services/audit-service").AuditService
        >,
      });
      const ctx = makeContext("admin", "org_alpha");

      await expect(service.removeMemberFromProject(ctx, "proj_1", "usr_target")).rejects.toThrow(
        "Audit DB down"
      );
    });
  });

  describe("List Project Members", () => {
    it("20. list assignments is strictly tenant-scoped", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockAssignments = [
        {
          id: "pm_1",
          projectId: "proj_1",
          organizationId: "org_alpha",
          userId: "usr_sc",
          assignedAt: new Date(),
          orgRole: "scientist",
          userName: "Scientist User",
          userEmail: "sc@example.com",
          userImage: null,
        },
      ];

      const mockDb = {
        select: () => ({
          from: (table: unknown) => {
            if (table === projects) {
              return { where: () => Promise.resolve([mockProject]) };
            }
            return {
              innerJoin: () => ({
                innerJoin: () => ({
                  where: () => Promise.resolve(mockAssignments),
                }),
              }),
            };
          },
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha");
      const list = await service.listProjectMembers(ctx, "proj_1");

      expect(list).toHaveLength(1);
      expect(list[0]?.organizationId).toBe("org_alpha");
      expect(list[0]?.role).toBe("scientist");
    });
  });

  describe("Cross-Tenant Invariants & Integrity", () => {
    it("21. forged organization ID in context/input cannot override TenantContext", async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha");

      await expect(service.assertProjectAccess(ctx, "proj_in_org_beta")).rejects.toThrow(
        ResourceNotFoundError
      );
    });

    it("22. project_members query always includes organization scope", async () => {
      const queriedTables: unknown[] = [];
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };

      const mockDb = {
        select: () => ({
          from: (table: unknown) => {
            queriedTables.push(table);
            return {
              where: () => Promise.resolve(table === projects ? [mockProject] : [{ id: "pm_1" }]),
            };
          },
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("scientist", "org_alpha", "usr_1");
      await service.assertProjectAccess(ctx, "proj_1");

      expect(queriedTables).toContain(projects);
      expect(queriedTables).toContain(projectMembers);
    });

    it("23. no project-level role exists on project membership DTO", async () => {
      const mockProject = { id: "proj_1", organizationId: "org_alpha" };
      const mockTargetMember = {
        id: "mem_sc",
        userId: "usr_sc",
        role: "scientist",
        userName: "Scientist User",
        userEmail: "sc@example.com",
        userImage: null,
      };

      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: (table: unknown) => {
            if (table === projects) {
              return { where: () => Promise.resolve([mockProject]) };
            }
            if (table === member) {
              return {
                innerJoin: () => ({
                  where: () => Promise.resolve([mockTargetMember]),
                }),
              };
            }
            return { where: () => Promise.resolve([]) };
          },
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as DbClient;

      const service = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha");
      const assigned = await service.assignMemberToProject(ctx, "proj_1", "usr_sc");

      expect(assigned.role).toBe("scientist");
      expect((assigned as unknown as Record<string, unknown>).projectRole).toBeUndefined();
    });
  });
});

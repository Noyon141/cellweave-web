import { describe, it, expect, vi } from "vitest";
import { MemberService, type BetterAuthMemberApi } from "@/server/services/member-service";
import {
  TenantAuthorizationError,
  ResourceNotFoundError,
  ValidationError,
} from "@/server/authorization";
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

describe("Member Application Service Tests (Step F / Step H)", () => {
  describe("List Members Authorization", () => {
    it("owner and admin can list same-org members", async () => {
      const mockRows = [
        {
          id: "mem_1",
          organizationId: "org_alpha",
          userId: "usr_1",
          role: "owner",
          createdAt: new Date(),
          userName: "Owner User",
          userEmail: "owner@example.com",
          userImage: null,
        },
        {
          id: "mem_2",
          organizationId: "org_alpha",
          userId: "usr_2",
          role: "scientist",
          createdAt: new Date(),
          userName: "Scientist User",
          userEmail: "scientist@example.com",
          userImage: null,
        },
      ];

      const mockDb = {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => Promise.resolve(mockRows),
            }),
          }),
        }),
      } as unknown as DbClient;

      const service = new MemberService({ dbClient: mockDb });

      const ownerCtx = makeContext("owner");
      const list1 = await service.listMembers(ownerCtx, "org_alpha");
      expect(list1).toHaveLength(2);
      expect(list1[0]?.role).toBe("owner");

      const adminCtx = makeContext("admin");
      const list2 = await service.listMembers(adminCtx, "org_alpha");
      expect(list2).toHaveLength(2);
    });

    it("rejects list query for foreign organization (IDOR prevention)", async () => {
      const service = new MemberService({ dbClient: {} as DbClient });
      const ctx = makeContext("owner", "org_alpha");

      await expect(service.listMembers(ctx, "org_beta_foreign")).rejects.toThrow(
        TenantAuthorizationError
      );
    });
  });

  describe("Member Mutation Authorization & Guards", () => {
    const unauthorizedMutators: OrganizationRole[] = ["bioinformatician", "scientist", "viewer"];

    for (const role of unauthorizedMutators) {
      it(`${role} cannot update member role`, async () => {
        const service = new MemberService({ dbClient: {} as DbClient });
        const ctx = makeContext(role);

        await expect(
          service.updateMemberRole(ctx, "org_alpha", "mem_target", "viewer")
        ).rejects.toThrow(TenantAuthorizationError);
      });

      it(`${role} cannot remove a member`, async () => {
        const service = new MemberService({ dbClient: {} as DbClient });
        const ctx = makeContext(role);

        await expect(service.removeMember(ctx, "org_alpha", "mem_target")).rejects.toThrow(
          TenantAuthorizationError
        );
      });
    }
  });

  describe("Role Updates by Owner and Admin", () => {
    const targetRoles: OrganizationRole[] = ["admin", "bioinformatician", "scientist", "viewer"];

    for (const targetRole of targetRoles) {
      it(`owner can assign canonical role '${targetRole}' via BetterAuth API`, async () => {
        const targetMember = {
          id: "mem_2",
          organizationId: "org_alpha",
          userId: "usr_2",
          role: "viewer",
          createdAt: new Date(),
          userName: "Test User",
          userEmail: "test@example.com",
          userImage: null,
        };

        const mockDb = {
          select: () => ({
            from: () => ({
              innerJoin: () => ({
                where: () => Promise.resolve([targetMember]),
              }),
            }),
          }),
          update: vi.fn(),
          delete: vi.fn(),
          insert: () => ({
            values: () => Promise.resolve(),
          }),
        } as unknown as DbClient;

        const mockAuthApi: BetterAuthMemberApi = {
          updateMemberRole: vi
            .fn()
            .mockResolvedValue({ member: { id: "mem_2", role: targetRole } }),
          removeMember: vi.fn(),
        };

        const service = new MemberService({ dbClient: mockDb, authApi: mockAuthApi });
        const ctx = makeContext("owner");
        const res = await service.updateMemberRole(ctx, "org_alpha", "mem_2", targetRole);

        expect(res.role).toBe(targetRole);
        expect(mockAuthApi.updateMemberRole).toHaveBeenCalledWith({
          body: {
            memberId: "mem_2",
            role: targetRole,
            organizationId: "org_alpha",
          },
          headers: undefined,
        });
        // Direct Drizzle mutations on BetterAuth member table MUST NOT be invoked
        expect(mockDb.update).not.toHaveBeenCalled();
        expect(mockDb.delete).not.toHaveBeenCalled();
      });

      it(`admin can assign canonical role '${targetRole}' via BetterAuth API`, async () => {
        const targetMember = {
          id: "mem_2",
          organizationId: "org_alpha",
          userId: "usr_2",
          role: "viewer",
          createdAt: new Date(),
          userName: "Test User",
          userEmail: "test@example.com",
          userImage: null,
        };

        const mockDb = {
          select: () => ({
            from: () => ({
              innerJoin: () => ({
                where: () => Promise.resolve([targetMember]),
              }),
            }),
          }),
          update: vi.fn(),
          delete: vi.fn(),
          insert: () => ({
            values: () => Promise.resolve(),
          }),
        } as unknown as DbClient;

        const mockAuthApi: BetterAuthMemberApi = {
          updateMemberRole: vi
            .fn()
            .mockResolvedValue({ member: { id: "mem_2", role: targetRole } }),
          removeMember: vi.fn(),
        };

        const service = new MemberService({ dbClient: mockDb, authApi: mockAuthApi });
        const ctx = makeContext("admin");
        const res = await service.updateMemberRole(ctx, "org_alpha", "mem_2", targetRole);

        expect(res.role).toBe(targetRole);
        expect(mockAuthApi.updateMemberRole).toHaveBeenCalledTimes(1);
        expect(mockDb.update).not.toHaveBeenCalled();
      });
    }

    it("admin cannot assign owner role", async () => {
      const targetMember = {
        id: "mem_2",
        organizationId: "org_alpha",
        userId: "usr_2",
        role: "admin",
        createdAt: new Date(),
        userName: "Test User",
        userEmail: "test@example.com",
        userImage: null,
      };

      const mockDb = {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => Promise.resolve([targetMember]),
            }),
          }),
        }),
      } as unknown as DbClient;

      const mockAuthApi: BetterAuthMemberApi = {
        updateMemberRole: vi.fn(),
        removeMember: vi.fn(),
      };

      const service = new MemberService({ dbClient: mockDb, authApi: mockAuthApi });
      const ctx = makeContext("admin");

      await expect(service.updateMemberRole(ctx, "org_alpha", "mem_2", "owner")).rejects.toThrow(
        TenantAuthorizationError
      );
      expect(mockAuthApi.updateMemberRole).not.toHaveBeenCalled();
    });

    it("admin cannot modify an owner membership", async () => {
      const ownerMember = {
        id: "mem_owner",
        organizationId: "org_alpha",
        userId: "usr_owner",
        role: "owner",
        createdAt: new Date(),
        userName: "Owner",
        userEmail: "owner@example.com",
        userImage: null,
      };

      const mockDb = {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => Promise.resolve([ownerMember]),
            }),
          }),
        }),
      } as unknown as DbClient;

      const mockAuthApi: BetterAuthMemberApi = {
        updateMemberRole: vi.fn(),
        removeMember: vi.fn(),
      };

      const service = new MemberService({ dbClient: mockDb, authApi: mockAuthApi });
      const ctx = makeContext("admin");

      await expect(
        service.updateMemberRole(ctx, "org_alpha", "mem_owner", "scientist")
      ).rejects.toThrow(TenantAuthorizationError);
      expect(mockAuthApi.updateMemberRole).not.toHaveBeenCalled();
    });

    it("admin cannot remove an owner", async () => {
      const ownerMember = {
        id: "mem_owner",
        organizationId: "org_alpha",
        userId: "usr_owner",
        role: "owner",
      };

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([ownerMember]),
          }),
        }),
      } as unknown as DbClient;

      const mockAuthApi: BetterAuthMemberApi = {
        updateMemberRole: vi.fn(),
        removeMember: vi.fn(),
      };

      const service = new MemberService({ dbClient: mockDb, authApi: mockAuthApi });
      const ctx = makeContext("admin");

      await expect(service.removeMember(ctx, "org_alpha", "mem_owner")).rejects.toThrow(
        TenantAuthorizationError
      );
      expect(mockAuthApi.removeMember).not.toHaveBeenCalled();
    });

    it("owner cannot be removed (prevents ownerless org)", async () => {
      const ownerMember = {
        id: "mem_owner",
        organizationId: "org_alpha",
        userId: "usr_owner",
        role: "owner",
      };

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([ownerMember]),
          }),
        }),
      } as unknown as DbClient;

      const mockAuthApi: BetterAuthMemberApi = {
        updateMemberRole: vi.fn(),
        removeMember: vi.fn(),
      };

      const service = new MemberService({ dbClient: mockDb, authApi: mockAuthApi });
      const ctx = makeContext("owner");

      await expect(service.removeMember(ctx, "org_alpha", "mem_owner")).rejects.toThrow(
        TenantAuthorizationError
      );
      expect(mockAuthApi.removeMember).not.toHaveBeenCalled();
    });

    it("rejects generic 'member' role", async () => {
      const service = new MemberService({ dbClient: {} as DbClient });
      const ctx = makeContext("owner");

      await expect(service.updateMemberRole(ctx, "org_alpha", "mem_1", "member")).rejects.toThrow(
        ValidationError
      );
    });

    it("rejects comma-separated role strings", async () => {
      const service = new MemberService({ dbClient: {} as DbClient });
      const ctx = makeContext("owner");

      await expect(
        service.updateMemberRole(ctx, "org_alpha", "mem_1", "admin,scientist")
      ).rejects.toThrow(ValidationError);
    });

    it("foreign-tenant member mutation is rejected and non-disclosing", async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => Promise.resolve([]), // not found in this org
            }),
          }),
        }),
      } as unknown as DbClient;

      const service = new MemberService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha");

      // IDOR attempt with foreign orgId in route
      await expect(
        service.updateMemberRole(ctx, "org_beta_foreign", "mem_target", "viewer")
      ).rejects.toThrow(TenantAuthorizationError);

      // Attempt targeting a memberId that exists in Org B while acting in Org A
      await expect(
        service.updateMemberRole(ctx, "org_alpha", "mem_belonging_to_org_b", "viewer")
      ).rejects.toThrow(ResourceNotFoundError);
    });

    it("triggers audit hook on role change and removal", async () => {
      const auditHook = vi.fn();
      const targetMember = {
        id: "mem_2",
        organizationId: "org_alpha",
        userId: "usr_2",
        role: "scientist",
        createdAt: new Date(),
        userName: "Scientist",
        userEmail: "sc@example.com",
        userImage: null,
      };

      const mockDb = {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => Promise.resolve([targetMember]),
            }),
            where: () => Promise.resolve([targetMember]),
          }),
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as DbClient;

      const mockAuthApi: BetterAuthMemberApi = {
        updateMemberRole: vi.fn().mockResolvedValue({}),
        removeMember: vi.fn().mockResolvedValue({}),
      };

      const service = new MemberService({ dbClient: mockDb, auditHook, authApi: mockAuthApi });
      const ctx = makeContext("owner", "org_alpha", "usr_actor_owner");

      // 1. Role Change
      await service.updateMemberRole(ctx, "org_alpha", "mem_2", "viewer");
      expect(mockAuthApi.updateMemberRole).toHaveBeenCalledTimes(1);
      expect(auditHook).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "member.role.changed",
          targetMemberId: "mem_2",
          oldRole: "scientist",
          newRole: "viewer",
        })
      );

      // 2. Removal
      await service.removeMember(ctx, "org_alpha", "mem_2");
      expect(mockAuthApi.removeMember).toHaveBeenCalledTimes(1);
      expect(auditHook).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "member.removed",
          targetMemberId: "mem_2",
          role: "scientist",
        })
      );
    });

    it("surfaces error when audit persistence fails after BetterAuth member role change", async () => {
      const targetMember = {
        id: "mem_fail",
        organizationId: "org_alpha",
        userId: "usr_fail",
        role: "viewer",
        createdAt: new Date(),
        userName: "Fail User",
        userEmail: "fail@example.com",
        userImage: null,
      };

      const mockDb = {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => Promise.resolve([targetMember]),
            }),
          }),
        }),
      } as unknown as DbClient;

      const mockAuthApi: BetterAuthMemberApi = {
        updateMemberRole: vi.fn().mockResolvedValue({}),
        removeMember: vi.fn(),
      };

      const failingAuditService = {
        recordUserAuditEvent: vi.fn().mockRejectedValue(new Error("Audit DB down")),
      };

      const service = new MemberService({
        dbClient: mockDb,
        authApi: mockAuthApi,
        auditService: failingAuditService as unknown as InstanceType<
          typeof import("@/server/services/audit-service").AuditService
        >,
      });
      const ctx = makeContext("owner", "org_alpha");

      await expect(
        service.updateMemberRole(ctx, "org_alpha", "mem_fail", "scientist")
      ).rejects.toThrow("Audit DB down");

      expect(mockAuthApi.updateMemberRole).toHaveBeenCalledTimes(1);
    });

    it("surfaces error when audit persistence fails after BetterAuth member removal", async () => {
      const targetMember = {
        id: "mem_fail",
        organizationId: "org_alpha",
        userId: "usr_fail",
        role: "scientist",
      };

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([targetMember]),
          }),
        }),
      } as unknown as DbClient;

      const mockAuthApi: BetterAuthMemberApi = {
        updateMemberRole: vi.fn(),
        removeMember: vi.fn().mockResolvedValue({}),
      };

      const failingAuditService = {
        recordUserAuditEvent: vi.fn().mockRejectedValue(new Error("Audit DB down")),
      };

      const service = new MemberService({
        dbClient: mockDb,
        authApi: mockAuthApi,
        auditService: failingAuditService as unknown as InstanceType<
          typeof import("@/server/services/audit-service").AuditService
        >,
      });
      const ctx = makeContext("owner", "org_alpha");

      await expect(service.removeMember(ctx, "org_alpha", "mem_fail")).rejects.toThrow(
        "Audit DB down"
      );

      expect(mockAuthApi.removeMember).toHaveBeenCalledTimes(1);
    });
  });
});

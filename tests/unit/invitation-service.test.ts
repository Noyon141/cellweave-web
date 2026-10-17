import { describe, it, expect, vi } from "vitest";
import {
  InvitationService,
  type BetterAuthInvitationApi,
} from "@/server/services/invitation-service";
import { invitation } from "@/server/database/schema/auth";
import {
  TenantAuthorizationError,
  ConflictError,
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

describe("Invitation Application Service Tests (Step F / Step H)", () => {
  describe("Invitation Creation Authorization & Role Bounds", () => {
    const canonicalNonOwnerRoles: OrganizationRole[] = [
      "admin",
      "bioinformatician",
      "scientist",
      "viewer",
    ];

    for (const targetRole of canonicalNonOwnerRoles) {
      it(`owner can invite canonical non-owner role '${targetRole}' via BetterAuth API`, async () => {
        const mockInsert = vi.fn().mockImplementation((table: unknown) => {
          if (table === invitation) {
            throw new Error("Direct Drizzle insert on BetterAuth invitation table is forbidden!");
          }
          return {
            values: () => Promise.resolve(),
          };
        });

        const mockDb = {
          select: () => ({
            from: () => ({
              where: () => Promise.resolve([]), // no active duplicate
            }),
          }),
          insert: mockInsert,
          update: vi.fn(),
          delete: vi.fn(),
        } as unknown as DbClient;

        const mockAuthApi: BetterAuthInvitationApi = {
          createInvitation: vi.fn().mockResolvedValue({
            id: "inv_auth_123",
            email: "colleague@example.com",
            role: targetRole,
            organizationId: "org_alpha",
            inviterId: "usr_actor",
            status: "pending",
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          }),
          cancelInvitation: vi.fn(),
        };

        const deliveryAdapter = { recordInvitation: vi.fn() };
        const service = new InvitationService({
          dbClient: mockDb,
          deliveryAdapter,
          authApi: mockAuthApi,
        });

        const ctx = makeContext("owner");
        const res = await service.createInvitation(ctx, "org_alpha", {
          email: "colleague@example.com",
          role: targetRole,
        });

        expect(res.role).toBe(targetRole);
        expect(res.email).toBe("colleague@example.com");
        expect(res.status).toBe("pending");
        expect(res.id).toBe("inv_auth_123");

        expect(mockAuthApi.createInvitation).toHaveBeenCalledWith({
          body: {
            email: "colleague@example.com",
            role: targetRole,
            organizationId: "org_alpha",
          },
          headers: undefined,
        });
        // Direct Drizzle insert on BetterAuth invitation table MUST NOT be invoked
        expect(mockInsert).not.toHaveBeenCalledWith(invitation);
        expect(deliveryAdapter.recordInvitation).toHaveBeenCalledTimes(1);
      });
    }

    it("admin can invite roles up to admin via BetterAuth API", async () => {
      const mockInsert = vi.fn().mockImplementation((table: unknown) => {
        if (table === invitation) {
          throw new Error("Direct Drizzle insert on BetterAuth invitation table is forbidden!");
        }
        return {
          values: () => Promise.resolve(),
        };
      });

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
        insert: mockInsert,
      } as unknown as DbClient;

      const mockAuthApi: BetterAuthInvitationApi = {
        createInvitation: vi.fn().mockResolvedValue({
          id: "inv_admin_456",
          email: "newadmin@example.com",
          role: "admin",
          organizationId: "org_alpha",
          inviterId: "usr_actor",
          status: "pending",
          expiresAt: new Date(),
        }),
        cancelInvitation: vi.fn(),
      };

      const service = new InvitationService({ dbClient: mockDb, authApi: mockAuthApi });
      const ctx = makeContext("admin");

      const res = await service.createInvitation(ctx, "org_alpha", {
        email: "newadmin@example.com",
        role: "admin",
      });
      expect(res.role).toBe("admin");
      expect(mockAuthApi.createInvitation).toHaveBeenCalledTimes(1);
      expect(mockInsert).not.toHaveBeenCalledWith(invitation);
    });

    it("admin cannot invite owner", async () => {
      const mockAuthApi: BetterAuthInvitationApi = {
        createInvitation: vi.fn(),
        cancelInvitation: vi.fn(),
      };
      const service = new InvitationService({ dbClient: {} as DbClient, authApi: mockAuthApi });
      const ctx = makeContext("admin");

      await expect(
        service.createInvitation(ctx, "org_alpha", {
          email: "newowner@example.com",
          role: "owner",
        })
      ).rejects.toThrow(TenantAuthorizationError);
      expect(mockAuthApi.createInvitation).not.toHaveBeenCalled();
    });

    it("owner invitation is rejected in Phase 1 even when requested by owner", async () => {
      const mockAuthApi: BetterAuthInvitationApi = {
        createInvitation: vi.fn(),
        cancelInvitation: vi.fn(),
      };
      const service = new InvitationService({ dbClient: {} as DbClient, authApi: mockAuthApi });
      const ctx = makeContext("owner");

      await expect(
        service.createInvitation(ctx, "org_alpha", {
          email: "owner2@example.com",
          role: "owner",
        })
      ).rejects.toThrow(TenantAuthorizationError);
      expect(mockAuthApi.createInvitation).not.toHaveBeenCalled();
    });

    const nonAdminRoles: OrganizationRole[] = ["bioinformatician", "scientist", "viewer"];
    for (const role of nonAdminRoles) {
      it(`${role} cannot invite members`, async () => {
        const mockAuthApi: BetterAuthInvitationApi = {
          createInvitation: vi.fn(),
          cancelInvitation: vi.fn(),
        };
        const service = new InvitationService({ dbClient: {} as DbClient, authApi: mockAuthApi });
        const ctx = makeContext(role);

        await expect(
          service.createInvitation(ctx, "org_alpha", {
            email: "someone@example.com",
            role: "scientist",
          })
        ).rejects.toThrow(TenantAuthorizationError);
        expect(mockAuthApi.createInvitation).not.toHaveBeenCalled();
      });
    }

    it("rejects non-canonical role string", async () => {
      const service = new InvitationService({ dbClient: {} as DbClient });
      const ctx = makeContext("owner");

      await expect(
        service.createInvitation(ctx, "org_alpha", {
          email: "test@example.com",
          role: "guest",
        })
      ).rejects.toThrow(ValidationError);
    });

    it("rejects invalid email format", async () => {
      const service = new InvitationService({ dbClient: {} as DbClient });
      const ctx = makeContext("owner");

      await expect(
        service.createInvitation(ctx, "org_alpha", {
          email: "not-an-email",
          role: "scientist",
        })
      ).rejects.toThrow(ValidationError);
    });

    it("rejects invitation creation for foreign organization", async () => {
      const service = new InvitationService({ dbClient: {} as DbClient });
      const ctx = makeContext("owner", "org_alpha");

      await expect(
        service.createInvitation(ctx, "org_beta_foreign", {
          email: "colleague@example.com",
          role: "scientist",
        })
      ).rejects.toThrow(TenantAuthorizationError);
    });
  });

  describe("Active Duplicate Prevention & Re-invitation", () => {
    it("rejects invitation when active pending invitation exists for normalized email", async () => {
      const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24); // +1 day
      const existingPending = [
        {
          id: "inv_existing",
          email: "colleague@example.com",
          status: "pending",
          expiresAt: futureDate,
        },
      ];

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve(existingPending),
          }),
        }),
      } as unknown as DbClient;

      const mockAuthApi: BetterAuthInvitationApi = {
        createInvitation: vi.fn(),
        cancelInvitation: vi.fn(),
      };

      const service = new InvitationService({ dbClient: mockDb, authApi: mockAuthApi });
      const ctx = makeContext("owner");

      await expect(
        service.createInvitation(ctx, "org_alpha", {
          email: "   COLLEAGUE@example.com  ",
          role: "scientist",
        })
      ).rejects.toThrow(ConflictError);
      expect(mockAuthApi.createInvitation).not.toHaveBeenCalled();
    });

    it("permits re-invitation if previous invitation expired or canceled", async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as DbClient;

      const mockAuthApi: BetterAuthInvitationApi = {
        createInvitation: vi.fn().mockResolvedValue({
          id: "inv_reinvited",
          email: "colleague@example.com",
          role: "scientist",
          organizationId: "org_alpha",
          inviterId: "usr_actor",
          status: "pending",
          expiresAt: new Date(),
        }),
        cancelInvitation: vi.fn(),
      };

      const service = new InvitationService({ dbClient: mockDb, authApi: mockAuthApi });
      const ctx = makeContext("owner");

      const res = await service.createInvitation(ctx, "org_alpha", {
        email: "colleague@example.com",
        role: "scientist",
      });

      expect(res.id).toBe("inv_reinvited");
      expect(mockAuthApi.createInvitation).toHaveBeenCalledTimes(1);
    });
  });

  describe("List Invitations", () => {
    it("lists invitations strictly scoped to active organization", async () => {
      const mockRows = [
        {
          id: "inv_1",
          organizationId: "org_alpha",
          email: "user1@example.com",
          role: "scientist",
          status: "pending",
          expiresAt: new Date(),
          createdAt: new Date(),
          inviterId: "usr_actor",
        },
      ];

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve(mockRows),
          }),
        }),
      } as unknown as DbClient;

      const service = new InvitationService({ dbClient: mockDb });
      const ctx = makeContext("admin");

      const list = await service.listInvitations(ctx, "org_alpha");
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe("inv_1");
    });

    it("rejects list invitations for foreign organization", async () => {
      const service = new InvitationService({ dbClient: {} as DbClient });
      const ctx = makeContext("admin", "org_alpha");

      await expect(service.listInvitations(ctx, "org_beta_foreign")).rejects.toThrow(
        TenantAuthorizationError
      );
    });

    it("non-admin roles cannot list invitations", async () => {
      const service = new InvitationService({ dbClient: {} as DbClient });
      const ctx = makeContext("scientist");

      await expect(service.listInvitations(ctx, "org_alpha")).rejects.toThrow(
        TenantAuthorizationError
      );
    });
  });

  describe("Cancel Invitation", () => {
    it("owner or admin can cancel pending invitation via BetterAuth API", async () => {
      const targetInv = {
        id: "inv_123",
        organizationId: "org_alpha",
        email: "pending@example.com",
        status: "pending",
      };

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([targetInv]),
          }),
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
        update: vi.fn(),
        delete: vi.fn(),
      } as unknown as DbClient;

      const mockAuthApi: BetterAuthInvitationApi = {
        createInvitation: vi.fn(),
        cancelInvitation: vi.fn().mockResolvedValue({}),
      };

      const auditHook = vi.fn();
      const service = new InvitationService({
        dbClient: mockDb,
        auditHook,
        authApi: mockAuthApi,
      });
      const ctx = makeContext("admin");

      await service.cancelInvitation(ctx, "org_alpha", "inv_123");

      expect(mockAuthApi.cancelInvitation).toHaveBeenCalledWith({
        body: {
          invitationId: "inv_123",
        },
        headers: undefined,
      });
      // Direct Drizzle update on BetterAuth invitation table MUST NOT be invoked
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(auditHook).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "invitation.canceled",
          invitationId: "inv_123",
        })
      );
    });

    it("cannot cancel already accepted or canceled invitation", async () => {
      const acceptedInv = {
        id: "inv_123",
        organizationId: "org_alpha",
        email: "accepted@example.com",
        status: "accepted",
      };

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([acceptedInv]),
          }),
        }),
      } as unknown as DbClient;

      const mockAuthApi: BetterAuthInvitationApi = {
        createInvitation: vi.fn(),
        cancelInvitation: vi.fn(),
      };

      const service = new InvitationService({ dbClient: mockDb, authApi: mockAuthApi });
      const ctx = makeContext("owner");

      await expect(service.cancelInvitation(ctx, "org_alpha", "inv_123")).rejects.toThrow(
        ConflictError
      );
      expect(mockAuthApi.cancelInvitation).not.toHaveBeenCalled();
    });

    it("rejects canceling foreign tenant invitation", async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]), // not found in this org
          }),
        }),
      } as unknown as DbClient;

      const service = new InvitationService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha");

      await expect(service.cancelInvitation(ctx, "org_alpha", "inv_foreign")).rejects.toThrow(
        ResourceNotFoundError
      );
    });

    it("surfaces error when audit persistence fails after BetterAuth invitation cancellation", async () => {
      const targetInv = {
        id: "inv_123",
        organizationId: "org_alpha",
        email: "pending@example.com",
        status: "pending",
      };

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([targetInv]),
          }),
        }),
      } as unknown as DbClient;

      const mockAuthApi: BetterAuthInvitationApi = {
        createInvitation: vi.fn(),
        cancelInvitation: vi.fn().mockResolvedValue({}),
      };

      const failingAuditService = {
        recordUserAuditEvent: vi.fn().mockRejectedValue(new Error("Audit DB down")),
      };

      const service = new InvitationService({
        dbClient: mockDb,
        authApi: mockAuthApi,
        auditService: failingAuditService as unknown as InstanceType<
          typeof import("@/server/services/audit-service").AuditService
        >,
      });
      const ctx = makeContext("admin", "org_alpha");

      await expect(service.cancelInvitation(ctx, "org_alpha", "inv_123")).rejects.toThrow(
        "Audit DB down"
      );
      expect(mockAuthApi.cancelInvitation).toHaveBeenCalledTimes(1);
    });

    it("surfaces error when audit persistence fails after BetterAuth invitation creation", async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
      } as unknown as DbClient;

      const mockAuthApi: BetterAuthInvitationApi = {
        createInvitation: vi.fn().mockResolvedValue({
          id: "inv_fail_123",
          email: "fail_invitee@example.com",
          role: "scientist",
          organizationId: "org_alpha",
          inviterId: "usr_actor",
          status: "pending",
          expiresAt: new Date(),
        }),
        cancelInvitation: vi.fn(),
      };

      const failingAuditService = {
        recordUserAuditEvent: vi.fn().mockRejectedValue(new Error("Audit DB down")),
      };

      const service = new InvitationService({
        dbClient: mockDb,
        authApi: mockAuthApi,
        auditService: failingAuditService as unknown as InstanceType<
          typeof import("@/server/services/audit-service").AuditService
        >,
      });
      const ctx = makeContext("owner", "org_alpha");

      await expect(
        service.createInvitation(ctx, "org_alpha", {
          email: "fail_invitee@example.com",
          role: "scientist",
        })
      ).rejects.toThrow("Audit DB down");

      expect(mockAuthApi.createInvitation).toHaveBeenCalledTimes(1);
    });
  });
});

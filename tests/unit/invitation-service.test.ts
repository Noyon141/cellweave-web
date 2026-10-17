import { describe, it, expect, vi } from "vitest";
import { InvitationService } from "@/server/services/invitation-service";
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

describe("Invitation Application Service Tests (Step F)", () => {
  describe("Invitation Creation Authorization & Role Bounds", () => {
    const canonicalNonOwnerRoles: OrganizationRole[] = [
      "admin",
      "bioinformatician",
      "scientist",
      "viewer",
    ];

    for (const targetRole of canonicalNonOwnerRoles) {
      it(`owner can invite canonical non-owner role '${targetRole}'`, async () => {
        let insertedValues: Record<string, unknown> | null = null;
        const mockDb = {
          transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
          select: () => ({
            from: () => ({
              where: () => Promise.resolve([]), // no active duplicate
            }),
          }),
          insert: () => ({
            values: (vals: Record<string, unknown>) => {
              insertedValues = vals;
              return Promise.resolve();
            },
          }),
        } as unknown as DbClient;

        const deliveryAdapter = { recordInvitation: vi.fn() };
        const service = new InvitationService({
          dbClient: mockDb,
          deliveryAdapter,
        });

        const ctx = makeContext("owner");
        const res = await service.createInvitation(ctx, "org_alpha", {
          email: "colleague@example.com",
          role: targetRole,
        });

        expect(res.role).toBe(targetRole);
        expect(res.email).toBe("colleague@example.com");
        expect(res.status).toBe("pending");
        expect(insertedValues).not.toBeNull();
        expect(deliveryAdapter.recordInvitation).toHaveBeenCalledTimes(1);
      });
    }

    it("admin can invite roles up to admin", async () => {
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as DbClient;

      const service = new InvitationService({ dbClient: mockDb });
      const ctx = makeContext("admin");

      const res = await service.createInvitation(ctx, "org_alpha", {
        email: "newadmin@example.com",
        role: "admin",
      });
      expect(res.role).toBe("admin");
    });

    it("admin cannot invite owner", async () => {
      const service = new InvitationService({ dbClient: {} as DbClient });
      const ctx = makeContext("admin");

      await expect(
        service.createInvitation(ctx, "org_alpha", {
          email: "newowner@example.com",
          role: "owner",
        })
      ).rejects.toThrow(TenantAuthorizationError);
    });

    it("owner invitation is rejected in Phase 1 (no improvised ownership transfer)", async () => {
      const service = new InvitationService({ dbClient: {} as DbClient });
      const ctx = makeContext("owner");

      await expect(
        service.createInvitation(ctx, "org_alpha", {
          email: "transfer@example.com",
          role: "owner",
        })
      ).rejects.toThrow(TenantAuthorizationError);
    });

    const unauthorizedInviters: OrganizationRole[] = ["bioinformatician", "scientist", "viewer"];

    for (const role of unauthorizedInviters) {
      it(`${role} cannot invite members`, async () => {
        const service = new InvitationService({ dbClient: {} as DbClient });
        const ctx = makeContext(role);

        await expect(
          service.createInvitation(ctx, "org_alpha", {
            email: "user@example.com",
            role: "viewer",
          })
        ).rejects.toThrow(TenantAuthorizationError);
      });
    }

    it("non-canonical role is rejected", async () => {
      const service = new InvitationService({ dbClient: {} as DbClient });
      const ctx = makeContext("owner");

      await expect(
        service.createInvitation(ctx, "org_alpha", {
          email: "user@example.com",
          role: "contributor_not_canonical",
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("Active Duplicate Prevention & Re-invitation Semantics", () => {
    it("rejects duplicate active pending invitation for identical email", async () => {
      const existingPending = {
        id: "inv_existing",
        email: "alice@example.com",
        status: "pending",
        expiresAt: new Date(Date.now() + 100000), // active in future
      };

      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([existingPending]),
          }),
        }),
      } as unknown as DbClient;

      const service = new InvitationService({ dbClient: mockDb });
      const ctx = makeContext("owner");

      await expect(
        service.createInvitation(ctx, "org_alpha", {
          email: "alice@example.com",
          role: "scientist",
        })
      ).rejects.toThrow(ConflictError);
    });

    it("email normalization prevents duplicate active invitations caused by case differences", async () => {
      const existingPending = {
        id: "inv_existing",
        email: "alice@example.com",
        status: "pending",
        expiresAt: new Date(Date.now() + 100000),
      };

      let queriedEmail: string | null = null;
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => {
              queriedEmail = "alice@example.com";
              return Promise.resolve([existingPending]);
            },
          }),
        }),
      } as unknown as DbClient;

      const service = new InvitationService({ dbClient: mockDb });
      const ctx = makeContext("admin");

      // Provided with uppercase / whitespace
      await expect(
        service.createInvitation(ctx, "org_alpha", {
          email: "  ALICE@EXAMPLE.COM  ",
          role: "scientist",
        })
      ).rejects.toThrow(ConflictError);

      expect(queriedEmail).toBe("alice@example.com");
    });

    it("expired invitation permits reinvitation", async () => {
      // In the database, the query filters for `expiresAt > now`.
      // If previous invitation is expired, the query returns 0 rows.
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]), // no active unexpired invitation
          }),
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as DbClient;

      const service = new InvitationService({ dbClient: mockDb });
      const ctx = makeContext("owner");

      const res = await service.createInvitation(ctx, "org_alpha", {
        email: "alice@example.com",
        role: "scientist",
      });

      expect(res.status).toBe("pending");
      expect(res.email).toBe("alice@example.com");
    });

    it("canceled or rejected historical invitation permits reinvitation", async () => {
      // Similarly, query filters for `status = 'pending'`.
      // Canceled/rejected rows do not match, returning 0 rows.
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as DbClient;

      const service = new InvitationService({ dbClient: mockDb });
      const ctx = makeContext("admin");

      const res = await service.createInvitation(ctx, "org_alpha", {
        email: "rejected_user@example.com",
        role: "viewer",
      });

      expect(res.status).toBe("pending");
    });

    it("invitation for foreign tenant cannot be created through forged orgId", async () => {
      const service = new InvitationService({ dbClient: {} as DbClient });
      const ctx = makeContext("owner", "org_alpha");

      await expect(
        service.createInvitation(ctx, "org_beta_foreign", {
          email: "target@example.com",
          role: "viewer",
        })
      ).rejects.toThrow(TenantAuthorizationError);
    });

    it("rolls back invitation creation when transactional audit persistence fails", async () => {
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as DbClient;

      const failingAuditService = {
        recordUserAuditEvent: vi.fn().mockRejectedValue(new Error("Audit DB down")),
      };

      const service = new InvitationService({
        dbClient: mockDb,
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
    });
  });

  describe("Cancel Invitation", () => {
    it("owner or admin can cancel pending invitation", async () => {
      const targetInv = {
        id: "inv_123",
        organizationId: "org_alpha",
        email: "pending@example.com",
        status: "pending",
      };

      let canceledStatus: string | null = null;
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([targetInv]),
          }),
        }),
        update: () => ({
          set: (vals: { status: string }) => {
            canceledStatus = vals.status;
            return {
              where: () => Promise.resolve(),
            };
          },
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as DbClient;

      const auditHook = vi.fn();
      const service = new InvitationService({ dbClient: mockDb, auditHook });
      const ctx = makeContext("admin");

      await service.cancelInvitation(ctx, "org_alpha", "inv_123");

      expect(canceledStatus).toBe("canceled");
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
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([acceptedInv]),
          }),
        }),
      } as unknown as DbClient;

      const service = new InvitationService({ dbClient: mockDb });
      const ctx = makeContext("owner");

      await expect(service.cancelInvitation(ctx, "org_alpha", "inv_123")).rejects.toThrow(
        ConflictError
      );
    });

    it("rejects canceling foreign tenant invitation", async () => {
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
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

    it("rolls back invitation cancellation when transactional audit persistence fails", async () => {
      const targetInv = {
        id: "inv_123",
        organizationId: "org_alpha",
        email: "pending@example.com",
        status: "pending",
      };

      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([targetInv]),
          }),
        }),
        update: () => ({
          set: () => ({
            where: () => Promise.resolve(),
          }),
        }),
      } as unknown as DbClient;

      const failingAuditService = {
        recordUserAuditEvent: vi.fn().mockRejectedValue(new Error("Audit DB down")),
      };

      const service = new InvitationService({
        dbClient: mockDb,
        auditService: failingAuditService as unknown as InstanceType<
          typeof import("@/server/services/audit-service").AuditService
        >,
      });
      const ctx = makeContext("admin", "org_alpha");

      await expect(service.cancelInvitation(ctx, "org_alpha", "inv_123")).rejects.toThrow(
        "Audit DB down"
      );
    });
  });
});

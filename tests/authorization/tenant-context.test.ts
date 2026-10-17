import { describe, it, expect, vi } from "vitest";
import {
  resolveTenantContext,
  validateTenantAccess,
  TenantAuthorizationError,
  UnauthenticatedError,
  TenantContextRequiredError,
  TenantMembershipNotFoundError,
  InvalidOrganizationRoleError,
} from "@/server/authorization/tenant-context";
import { assertRole, assertOwner, assertOrgAdmin } from "@/server/authorization/guards";
import { ORGANIZATION_ROLES, type OrganizationRole, type TenantContext } from "@/types";
import type { DbClient } from "@/server/database/client";

function createMockDb(
  memberships: Array<{
    id: string;
    organizationId: string;
    userId: string;
    role: string;
  }>
): DbClient {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(memberships),
      }),
    }),
  } as unknown as DbClient;
}

function createMockAuth(
  sessionResult: {
    user: { id: string; email?: string | null };
    session: { id: string; userId: string; activeOrganizationId?: string | null };
  } | null
) {
  return {
    api: {
      getSession: vi.fn().mockResolvedValue(sessionResult),
    },
  };
}

describe("Tenant Context Resolution & Core Authorization Matrix", () => {
  const dummyHeaders = new Headers();

  describe("1. Unauthenticated Request Rejection", () => {
    it("rejects when getSession returns null", async () => {
      const mockAuth = createMockAuth(null);
      const mockDb = createMockDb([]);

      await expect(
        resolveTenantContext({
          requestOrHeaders: dummyHeaders,
          authClient: mockAuth as unknown as Parameters<
            typeof resolveTenantContext
          >[0]["authClient"],
          dbClient: mockDb,
        })
      ).rejects.toThrow(UnauthenticatedError);
    });

    it("rejects when getSession throws an error", async () => {
      const mockAuth = {
        api: {
          getSession: vi.fn().mockRejectedValue(new Error("Network failure")),
        },
      };
      const mockDb = createMockDb([]);

      await expect(
        resolveTenantContext({
          requestOrHeaders: dummyHeaders,
          authClient: mockAuth as unknown as Parameters<
            typeof resolveTenantContext
          >[0]["authClient"],
          dbClient: mockDb,
        })
      ).rejects.toThrow(UnauthenticatedError);
    });

    it("rejects when session.userId mismatches user.id", async () => {
      const mockAuth = createMockAuth({
        user: { id: "usr_alice" },
        session: { id: "sess_1", userId: "usr_bob", activeOrganizationId: "org_alpha" },
      });
      const mockDb = createMockDb([]);

      await expect(
        resolveTenantContext({
          requestOrHeaders: dummyHeaders,
          authClient: mockAuth as unknown as Parameters<
            typeof resolveTenantContext
          >[0]["authClient"],
          dbClient: mockDb,
        })
      ).rejects.toThrow(UnauthenticatedError);
    });
  });

  describe("2. Authenticated Session with No activeOrganizationId Rejection", () => {
    it("rejects when activeOrganizationId is undefined", async () => {
      const mockAuth = createMockAuth({
        user: { id: "usr_alice" },
        session: { id: "sess_1", userId: "usr_alice", activeOrganizationId: undefined },
      });
      const mockDb = createMockDb([]);

      await expect(
        resolveTenantContext({
          requestOrHeaders: dummyHeaders,
          authClient: mockAuth as unknown as Parameters<
            typeof resolveTenantContext
          >[0]["authClient"],
          dbClient: mockDb,
        })
      ).rejects.toThrow(TenantContextRequiredError);
    });

    it("rejects when activeOrganizationId is an empty string", async () => {
      const mockAuth = createMockAuth({
        user: { id: "usr_alice" },
        session: { id: "sess_1", userId: "usr_alice", activeOrganizationId: "   " },
      });
      const mockDb = createMockDb([]);

      await expect(
        resolveTenantContext({
          requestOrHeaders: dummyHeaders,
          authClient: mockAuth as unknown as Parameters<
            typeof resolveTenantContext
          >[0]["authClient"],
          dbClient: mockDb,
        })
      ).rejects.toThrow(TenantContextRequiredError);
    });
  });

  describe("3. Valid Active Membership Returns Canonical TenantContext", () => {
    it("resolves canonical TenantContext successfully for valid member", async () => {
      const mockAuth = createMockAuth({
        user: { id: "usr_alice" },
        session: { id: "sess_1", userId: "usr_alice", activeOrganizationId: "org_alpha" },
      });
      const mockDb = createMockDb([
        {
          id: "mem_1",
          organizationId: "org_alpha",
          userId: "usr_alice",
          role: "scientist",
        },
      ]);

      const context = await resolveTenantContext({
        requestOrHeaders: dummyHeaders,
        authClient: mockAuth as unknown as Parameters<typeof resolveTenantContext>[0]["authClient"],
        dbClient: mockDb,
      });

      expect(context).toEqual({
        organizationId: "org_alpha",
        userId: "usr_alice",
        role: "scientist",
      });
      expect(Object.isFrozen(context)).toBe(true);
    });
  });

  describe("4. Canonical TenantContext Exact Structure", () => {
    it("returns context with EXACTLY organizationId, userId, and role — no extra fields", async () => {
      const mockAuth = createMockAuth({
        user: { id: "usr_alice" },
        session: { id: "sess_1", userId: "usr_alice", activeOrganizationId: "org_alpha" },
      });
      const mockDb = createMockDb([
        {
          id: "mem_1",
          organizationId: "org_alpha",
          userId: "usr_alice",
          role: "bioinformatician",
        },
      ]);

      const context = await resolveTenantContext({
        requestOrHeaders: dummyHeaders,
        authClient: mockAuth as unknown as Parameters<typeof resolveTenantContext>[0]["authClient"],
        dbClient: mockDb,
      });

      const keys = Object.keys(context).sort();
      expect(keys).toEqual(["organizationId", "role", "userId"]);

      // Explicitly assert forbidden leaked properties are absent
      expect((context as unknown as Record<string, unknown>).sessionId).toBeUndefined();
      expect((context as unknown as Record<string, unknown>).projectId).toBeUndefined();
      expect((context as unknown as Record<string, unknown>).permissions).toBeUndefined();
      expect((context as unknown as Record<string, unknown>).claims).toBeUndefined();
    });
  });

  describe("5. Client-Supplied organizationId Cannot Override Session Organization (Cross-Tenant Foundation)", () => {
    it("ignores browser-provided query/body/header organizationId and enforces session tenant", async () => {
      // User is authenticated in Org A via session
      const mockAuth = createMockAuth({
        user: { id: "usr_alice" },
        session: { id: "sess_1", userId: "usr_alice", activeOrganizationId: "org_alpha" },
      });
      const mockDb = createMockDb([
        {
          id: "mem_1",
          organizationId: "org_alpha",
          userId: "usr_alice",
          role: "owner",
        },
      ]);

      // Client request supplies Org B in headers/URL/body
      const maliciousRequestHeaders = new Headers();
      maliciousRequestHeaders.set("x-organization-id", "org_beta_foreign");

      const resolved = await resolveTenantContext({
        requestOrHeaders: maliciousRequestHeaders,
        authClient: mockAuth as unknown as Parameters<typeof resolveTenantContext>[0]["authClient"],
        dbClient: mockDb,
      });

      // INVARIANT: Context remains Org Alpha
      expect(resolved.organizationId).toBe("org_alpha");
      expect(resolved.organizationId).not.toBe("org_beta_foreign");

      // Validating against target Org B must be strictly rejected
      expect(() => {
        validateTenantAccess(resolved, "org_beta_foreign");
      }).toThrow(TenantAuthorizationError);
    });
  });

  describe("6. Removed Membership Causes Immediate Denial", () => {
    it("rejects immediately if membership row was deleted even with valid session", async () => {
      const mockAuth = createMockAuth({
        user: { id: "usr_alice" },
        session: { id: "sess_1", userId: "usr_alice", activeOrganizationId: "org_alpha" },
      });
      // Database returns 0 rows (revoked/deleted membership)
      const mockDb = createMockDb([]);

      await expect(
        resolveTenantContext({
          requestOrHeaders: dummyHeaders,
          authClient: mockAuth as unknown as Parameters<
            typeof resolveTenantContext
          >[0]["authClient"],
          dbClient: mockDb,
        })
      ).rejects.toThrow(TenantMembershipNotFoundError);
    });
  });

  describe("7. Changed Membership Role Is Reflected Immediately", () => {
    it("returns newly updated role directly from DB query regardless of session creation time", async () => {
      const mockAuth = createMockAuth({
        user: { id: "usr_alice" },
        session: { id: "sess_1", userId: "usr_alice", activeOrganizationId: "org_alpha" },
      });
      // Database contains updated role: previously scientist, now demoted to viewer
      const mockDb = createMockDb([
        {
          id: "mem_1",
          organizationId: "org_alpha",
          userId: "usr_alice",
          role: "viewer",
        },
      ]);

      const context = await resolveTenantContext({
        requestOrHeaders: dummyHeaders,
        authClient: mockAuth as unknown as Parameters<typeof resolveTenantContext>[0]["authClient"],
        dbClient: mockDb,
      });

      expect(context.role).toBe("viewer");
    });
  });

  describe("8. Stale activeOrganizationId with No Membership Rejected", () => {
    it("rejects if user session points to an org they were never member of", async () => {
      const mockAuth = createMockAuth({
        user: { id: "usr_charlie" },
        session: { id: "sess_3", userId: "usr_charlie", activeOrganizationId: "org_unrelated" },
      });
      const mockDb = createMockDb([]);

      await expect(
        resolveTenantContext({
          requestOrHeaders: dummyHeaders,
          authClient: mockAuth as unknown as Parameters<
            typeof resolveTenantContext
          >[0]["authClient"],
          dbClient: mockDb,
        })
      ).rejects.toThrow(TenantMembershipNotFoundError);
    });
  });

  describe("9. All Five Canonical Roles Resolve Correctly", () => {
    const roles: OrganizationRole[] = ["owner", "admin", "bioinformatician", "scientist", "viewer"];

    for (const r of roles) {
      it(`resolves canonical role '${r}' successfully`, async () => {
        const mockAuth = createMockAuth({
          user: { id: "usr_test" },
          session: { id: "sess_test", userId: "usr_test", activeOrganizationId: "org_test" },
        });
        const mockDb = createMockDb([
          {
            id: "mem_test",
            organizationId: "org_test",
            userId: "usr_test",
            role: r,
          },
        ]);

        const context = await resolveTenantContext({
          requestOrHeaders: dummyHeaders,
          authClient: mockAuth as unknown as Parameters<
            typeof resolveTenantContext
          >[0]["authClient"],
          dbClient: mockDb,
        });

        expect(context.role).toBe(r);
      });
    }
  });

  describe("10. Invalid / Non-Canonical Role Fails Closed", () => {
    it("rejects arbitrary or unknown role string in database", async () => {
      const mockAuth = createMockAuth({
        user: { id: "usr_test" },
        session: { id: "sess_test", userId: "usr_test", activeOrganizationId: "org_test" },
      });
      const mockDb = createMockDb([
        {
          id: "mem_test",
          organizationId: "org_test",
          userId: "usr_test",
          role: "invented_contributor",
        },
      ]);

      await expect(
        resolveTenantContext({
          requestOrHeaders: dummyHeaders,
          authClient: mockAuth as unknown as Parameters<
            typeof resolveTenantContext
          >[0]["authClient"],
          dbClient: mockDb,
        })
      ).rejects.toThrow(InvalidOrganizationRoleError);
    });
  });

  describe("11. Role Guard assertOwner", () => {
    it("accepts owner role", () => {
      const ctx: TenantContext = {
        organizationId: "org_1",
        userId: "usr_1",
        role: "owner",
      };
      expect(() => assertOwner(ctx)).not.toThrow();
    });

    const nonOwnerRoles: OrganizationRole[] = ["admin", "bioinformatician", "scientist", "viewer"];

    for (const r of nonOwnerRoles) {
      it(`rejects non-owner role '${r}'`, () => {
        const ctx: TenantContext = {
          organizationId: "org_1",
          userId: "usr_1",
          role: r,
        };
        expect(() => assertOwner(ctx)).toThrow(TenantAuthorizationError);
      });
    }

    it("rejects null or undefined context", () => {
      expect(() => assertOwner(null)).toThrow(TenantAuthorizationError);
      expect(() => assertOwner(undefined)).toThrow(TenantAuthorizationError);
    });
  });

  describe("12. Role Guard assertOrgAdmin", () => {
    it("accepts owner role", () => {
      const ctx: TenantContext = {
        organizationId: "org_1",
        userId: "usr_1",
        role: "owner",
      };
      expect(() => assertOrgAdmin(ctx)).not.toThrow();
    });

    it("accepts admin role", () => {
      const ctx: TenantContext = {
        organizationId: "org_1",
        userId: "usr_1",
        role: "admin",
      };
      expect(() => assertOrgAdmin(ctx)).not.toThrow();
    });

    const nonAdminRoles: OrganizationRole[] = ["bioinformatician", "scientist", "viewer"];

    for (const r of nonAdminRoles) {
      it(`rejects non-admin role '${r}'`, () => {
        const ctx: TenantContext = {
          organizationId: "org_1",
          userId: "usr_1",
          role: r,
        };
        expect(() => assertOrgAdmin(ctx)).toThrow(TenantAuthorizationError);
      });
    }
  });

  describe("13. Role Guards Conformance to Canonical Roles", () => {
    it("assertRole checks against canonical ORGANIZATION_ROLES list only", () => {
      const ctx: TenantContext = {
        organizationId: "org_1",
        userId: "usr_1",
        role: "scientist",
      };

      expect(() => assertRole(ctx, ["scientist", "bioinformatician"])).not.toThrow();
      expect(() => assertRole(ctx, ["admin"])).toThrow(TenantAuthorizationError);

      // Verify that all canonical roles are covered
      for (const canonicalRole of ORGANIZATION_ROLES) {
        const testContext: TenantContext = {
          organizationId: "org_1",
          userId: "usr_1",
          role: canonicalRole,
        };
        expect(() => assertRole(testContext, [canonicalRole])).not.toThrow();
      }
    });
  });

  describe("14. Duplicate-Membership Impossible-State Fails Closed", () => {
    it("fails closed with TenantAuthorizationError if database returns multiple rows", async () => {
      const mockAuth = createMockAuth({
        user: { id: "usr_alice" },
        session: { id: "sess_1", userId: "usr_alice", activeOrganizationId: "org_alpha" },
      });
      // Mock impossible corruption state: two rows for same user and org
      const mockDb = createMockDb([
        {
          id: "mem_1",
          organizationId: "org_alpha",
          userId: "usr_alice",
          role: "owner",
        },
        {
          id: "mem_2",
          organizationId: "org_alpha",
          userId: "usr_alice",
          role: "admin",
        },
      ]);

      await expect(
        resolveTenantContext({
          requestOrHeaders: dummyHeaders,
          authClient: mockAuth as unknown as Parameters<
            typeof resolveTenantContext
          >[0]["authClient"],
          dbClient: mockDb,
        })
      ).rejects.toThrow(TenantAuthorizationError);
    });
  });
});

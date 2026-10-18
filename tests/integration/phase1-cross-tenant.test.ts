import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  user,
  organization,
  member,
  projects,
  projectMembers,
  organizationSettings,
  auditEvents,
} from "@/server/database/schema";
import { getDb, type DbClient } from "@/server/database/client";
import {
  resolveTenantContext,
  validateTenantAccess,
  TenantAuthorizationError,
  UnauthenticatedError,
  TenantContextRequiredError,
  TenantMembershipNotFoundError,
  ResourceNotFoundError,
  ValidationError,
} from "@/server/authorization";
import { handleRouteError } from "@/server/api/error-handler";
import { OrganizationService } from "@/server/services/organization-service";
import { MemberService } from "@/server/services/member-service";
import { InvitationService } from "@/server/services/invitation-service";
import { ProjectPermissionService } from "@/server/services/project-permission-service";
import { AuditService } from "@/server/services/audit-service";
import type { TenantContext, OrganizationRole } from "@/types";
import { randomUUID } from "node:crypto";

// Ensure DEV environment is loaded if running in Node 20+
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Already set or fallback
  }
}

describe("Phase 1 Development Exit Suite: Automated Cross-Tenant & RBAC Verification", () => {
  const db: DbClient = getDb();
  const testRunId = randomUUID().replace(/-/g, "").slice(0, 12);

  // Deterministic DEV fixture identifiers
  const orgAId = `dev_exit_org_a_${testRunId}`;
  const orgBId = `dev_exit_org_b_${testRunId}`;

  const userOwnerA = `dev_exit_usr_owner_a_${testRunId}`;
  const userAdminA = `dev_exit_usr_admin_a_${testRunId}`;
  const userBioA = `dev_exit_usr_bio_a_${testRunId}`;
  const userSciA = `dev_exit_usr_sci_a_${testRunId}`;
  const userViewA = `dev_exit_usr_view_a_${testRunId}`;

  const userOwnerB = `dev_exit_usr_owner_b_${testRunId}`;
  const userSciB = `dev_exit_usr_sci_b_${testRunId}`;
  const userMulti = `dev_exit_usr_multi_${testRunId}`;

  const projA1Id = `dev_exit_prj_a1_${testRunId}`;
  const projA2Id = `dev_exit_prj_a2_${testRunId}`;
  const projB1Id = `dev_exit_prj_b1_${testRunId}`;

  let memberOwnerAId: string;
  let memberAdminAId: string;
  let memberBioAId: string;
  let memberSciAId: string;
  let memberViewAId: string;

  let memberOwnerBId: string;
  let memberSciBId: string;

  let memberMultiAId: string;
  let memberMultiBId: string;

  let projMemberBioA1Id: string;
  let projMemberSciA1Id: string;

  // Real application services connected to DEV Neon PostgreSQL
  const orgService = new OrganizationService({ dbClient: db });
  const memberService = new MemberService({ dbClient: db });
  const invitationService = new InvitationService({ dbClient: db });
  const projectService = new ProjectPermissionService({ dbClient: db });
  const auditService = new AuditService({ dbClient: db });

  beforeAll(async () => {
    const now = new Date();

    // 1. Insert DEV Test Organizations
    await db.insert(organization).values([
      {
        id: orgAId,
        name: `CellWeave Exit Test Org A ${testRunId}`,
        slug: `dev-exit-org-a-${testRunId}`,
        createdAt: now,
      },
      {
        id: orgBId,
        name: `CellWeave Exit Test Org B ${testRunId}`,
        slug: `dev-exit-org-b-${testRunId}`,
        createdAt: now,
      },
    ]);

    // 2. Insert DEV Test Users
    await db.insert(user).values([
      {
        id: userOwnerA,
        name: "DEV Exit Owner A",
        email: `owner_a_${testRunId}@cellweave.dev`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: userAdminA,
        name: "DEV Exit Admin A",
        email: `admin_a_${testRunId}@cellweave.dev`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: userBioA,
        name: "DEV Exit Bioinformatician A",
        email: `bio_a_${testRunId}@cellweave.dev`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: userSciA,
        name: "DEV Exit Scientist A",
        email: `sci_a_${testRunId}@cellweave.dev`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: userViewA,
        name: "DEV Exit Viewer A",
        email: `view_a_${testRunId}@cellweave.dev`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: userOwnerB,
        name: "DEV Exit Owner B",
        email: `owner_b_${testRunId}@cellweave.dev`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: userSciB,
        name: "DEV Exit Scientist B",
        email: `sci_b_${testRunId}@cellweave.dev`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: userMulti,
        name: "DEV Exit Multi Member",
        email: `multi_${testRunId}@cellweave.dev`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // 3. Insert DEV Test Memberships
    memberOwnerAId = `dev_exit_mem_owner_a_${testRunId}`;
    memberAdminAId = `dev_exit_mem_admin_a_${testRunId}`;
    memberBioAId = `dev_exit_mem_bio_a_${testRunId}`;
    memberSciAId = `dev_exit_mem_sci_a_${testRunId}`;
    memberViewAId = `dev_exit_mem_view_a_${testRunId}`;

    memberOwnerBId = `dev_exit_mem_owner_b_${testRunId}`;
    memberSciBId = `dev_exit_mem_sci_b_${testRunId}`;

    memberMultiAId = `dev_exit_mem_multi_a_${testRunId}`;
    memberMultiBId = `dev_exit_mem_multi_b_${testRunId}`;

    await db.insert(member).values([
      {
        id: memberOwnerAId,
        organizationId: orgAId,
        userId: userOwnerA,
        role: "owner",
        createdAt: now,
      },
      {
        id: memberAdminAId,
        organizationId: orgAId,
        userId: userAdminA,
        role: "admin",
        createdAt: now,
      },
      {
        id: memberBioAId,
        organizationId: orgAId,
        userId: userBioA,
        role: "bioinformatician",
        createdAt: now,
      },
      {
        id: memberSciAId,
        organizationId: orgAId,
        userId: userSciA,
        role: "scientist",
        createdAt: now,
      },
      {
        id: memberViewAId,
        organizationId: orgAId,
        userId: userViewA,
        role: "viewer",
        createdAt: now,
      },
      {
        id: memberOwnerBId,
        organizationId: orgBId,
        userId: userOwnerB,
        role: "owner",
        createdAt: now,
      },
      {
        id: memberSciBId,
        organizationId: orgBId,
        userId: userSciB,
        role: "scientist",
        createdAt: now,
      },
      {
        id: memberMultiAId,
        organizationId: orgAId,
        userId: userMulti,
        role: "scientist",
        createdAt: now,
      },
      {
        id: memberMultiBId,
        organizationId: orgBId,
        userId: userMulti,
        role: "scientist",
        createdAt: now,
      },
    ]);

    // 4. Insert DEV Test Projects
    await db.insert(projects).values([
      {
        id: projA1Id,
        organizationId: orgAId,
        name: `Project A1 ${testRunId}`,
        createdBy: userOwnerA,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: projA2Id,
        organizationId: orgAId,
        name: `Project A2 ${testRunId}`,
        createdBy: userOwnerA,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: projB1Id,
        organizationId: orgBId,
        name: `Project B1 ${testRunId}`,
        createdBy: userOwnerB,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // 5. Insert initial project member assignments
    projMemberBioA1Id = `dev_exit_pm_bio_a1_${testRunId}`;
    projMemberSciA1Id = `dev_exit_pm_sci_a1_${testRunId}`;

    await db.insert(projectMembers).values([
      {
        id: projMemberBioA1Id,
        organizationId: orgAId,
        projectId: projA1Id,
        userId: userBioA,
        createdAt: now,
      },
      {
        id: projMemberSciA1Id,
        organizationId: orgAId,
        projectId: projA1Id,
        userId: userSciA,
        createdAt: now,
      },
    ]);

    // 6. Insert initial organization settings
    await db.insert(organizationSettings).values([
      {
        organizationId: orgAId,
        defaultRetentionDays: 30,
        projectVisibility: "private",
        updatedAt: now,
        updatedBy: userOwnerA,
      },
      {
        organizationId: orgBId,
        defaultRetentionDays: 45,
        projectVisibility: "private",
        updatedAt: now,
        updatedBy: userOwnerB,
      },
    ]);
  });

  afterAll(async () => {
    // Cleanup temporary DEV fixtures (only those with our testRunId prefix)
    try {
      await db
        .delete(projectMembers)
        .where(
          and(eq(projectMembers.organizationId, orgAId), eq(projectMembers.projectId, projA1Id))
        );
      await db.delete(projects).where(eq(projects.organizationId, orgAId));
      await db.delete(projects).where(eq(projects.organizationId, orgBId));
      await db.delete(organizationSettings).where(eq(organizationSettings.organizationId, orgAId));
      await db.delete(organizationSettings).where(eq(organizationSettings.organizationId, orgBId));
      await db.delete(member).where(eq(member.organizationId, orgAId));
      await db.delete(member).where(eq(member.organizationId, orgBId));
      await db.delete(user).where(eq(user.id, userOwnerA));
      await db.delete(user).where(eq(user.id, userAdminA));
      await db.delete(user).where(eq(user.id, userBioA));
      await db.delete(user).where(eq(user.id, userSciA));
      await db.delete(user).where(eq(user.id, userViewA));
      await db.delete(user).where(eq(user.id, userOwnerB));
      await db.delete(user).where(eq(user.id, userSciB));
      await db.delete(user).where(eq(user.id, userMulti));
      await db.delete(organization).where(eq(organization.id, orgAId));
      await db.delete(organization).where(eq(organization.id, orgBId));
    } catch {
      // Best-effort cleanup; operator data remains untouched
    }
  });

  // Helper to create mocked BetterAuth client injecting specific session for resolveTenantContext
  function createTestAuthClient(
    sessionData: {
      user: { id: string; email?: string | null };
      session: { id: string; userId: string; activeOrganizationId?: string | null };
    } | null
  ): NonNullable<Parameters<typeof resolveTenantContext>[0]["authClient"]> {
    return {
      api: {
        getSession: (async () => sessionData) as unknown,
      },
    } as unknown as NonNullable<Parameters<typeof resolveTenantContext>[0]["authClient"]>;
  }

  // =========================================================================
  // 1. AUTHENTICATION & SERVER-VALIDATED TENANTCONTEXT (SECTION 4)
  // =========================================================================
  describe("1. Authentication & TenantContext Resolution (Section 4)", () => {
    it("4.1: unauthenticated tenant route is denied with HTTP 401", async () => {
      const authClient = createTestAuthClient(null);
      let errorThrown: unknown;
      try {
        await resolveTenantContext({
          requestOrHeaders: new Headers(),
          authClient,
          dbClient: db,
        });
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).toBeInstanceOf(UnauthenticatedError);
      const res = handleRouteError(errorThrown);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; message: string };
      expect(body).toEqual({
        error: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    });

    it("4.2: authenticated session with no activeOrganizationId is denied with HTTP 403", async () => {
      const authClient = createTestAuthClient({
        user: { id: userOwnerA, email: "owner_a@cellweave.dev" },
        session: {
          id: "sess_no_org",
          userId: userOwnerA,
          activeOrganizationId: null,
        },
      });

      let errorThrown: unknown;
      try {
        await resolveTenantContext({
          requestOrHeaders: new Headers(),
          authClient,
          dbClient: db,
        });
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).toBeInstanceOf(TenantContextRequiredError);
      const res = handleRouteError(errorThrown);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; message: string };
      expect(body).toEqual({
        error: "FORBIDDEN",
        message: "You are not authorized to access this resource.",
      });
    });

    it("4.3: valid Org A user with active Org A resolves Org A TenantContext from real PostgreSQL", async () => {
      const authClient = createTestAuthClient({
        user: { id: userOwnerA, email: "owner_a@cellweave.dev" },
        session: {
          id: "sess_owner_a",
          userId: userOwnerA,
          activeOrganizationId: orgAId,
        },
      });

      const context = await resolveTenantContext({
        requestOrHeaders: new Headers(),
        authClient,
        dbClient: db,
      });

      expect(context.organizationId).toBe(orgAId);
      expect(context.userId).toBe(userOwnerA);
      expect(context.role).toBe("owner");
      expect(Object.isFrozen(context)).toBe(true);
    });

    it("4.4 & 4.6: removed Org A membership invalidates access on next request even with activeOrg in session", async () => {
      // Create a temporary member to delete
      const tempUserId = `dev_exit_usr_temp_${testRunId}`;
      const tempMemberId = `dev_exit_mem_temp_${testRunId}`;
      const now = new Date();

      await db.insert(user).values({
        id: tempUserId,
        name: "Temp User",
        email: `temp_${testRunId}@cellweave.dev`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(member).values({
        id: tempMemberId,
        organizationId: orgAId,
        userId: tempUserId,
        role: "viewer",
        createdAt: now,
      });

      const authClient = createTestAuthClient({
        user: { id: tempUserId, email: `temp_${testRunId}@cellweave.dev` },
        session: {
          id: "sess_temp",
          userId: tempUserId,
          activeOrganizationId: orgAId,
        },
      });

      // 1. Initial access succeeds
      const initialContext = await resolveTenantContext({
        requestOrHeaders: new Headers(),
        authClient,
        dbClient: db,
      });
      expect(initialContext.userId).toBe(tempUserId);
      expect(initialContext.role).toBe("viewer");

      // 2. Delete member row from real PostgreSQL
      await db.delete(member).where(eq(member.id, tempMemberId));

      // 3. Next request fails immediately (stale session does NOT retain access)
      let errorThrown: unknown;
      try {
        await resolveTenantContext({
          requestOrHeaders: new Headers(),
          authClient,
          dbClient: db,
        });
      } catch (err) {
        errorThrown = err;
      }

      expect(errorThrown).toBeInstanceOf(TenantMembershipNotFoundError);
      const res = handleRouteError(errorThrown);
      expect(res.status).toBe(403);

      // Cleanup temp user
      await db.delete(user).where(eq(user.id, tempUserId));
    });

    it("4.5: role change in PostgreSQL is immediately reflected on next request", async () => {
      const authClient = createTestAuthClient({
        user: { id: userBioA, email: `bio_a_${testRunId}@cellweave.dev` },
        session: {
          id: "sess_bio_a",
          userId: userBioA,
          activeOrganizationId: orgAId,
        },
      });

      // Initially bioinformatician
      const ctx1 = await resolveTenantContext({
        requestOrHeaders: new Headers(),
        authClient,
        dbClient: db,
      });
      expect(ctx1.role).toBe("bioinformatician");

      // Update role in DB to scientist
      await db.update(member).set({ role: "scientist" }).where(eq(member.id, memberBioAId));

      // Next request immediately sees "scientist"
      const ctx2 = await resolveTenantContext({
        requestOrHeaders: new Headers(),
        authClient,
        dbClient: db,
      });
      expect(ctx2.role).toBe("scientist");

      // Revert role back to bioinformatician for subsequent tests
      await db.update(member).set({ role: "bioinformatician" }).where(eq(member.id, memberBioAId));
    });

    it("4.7: forged organizationId cannot override server-resolved TenantContext", () => {
      const activeContext: TenantContext = Object.freeze({
        organizationId: orgAId,
        userId: userOwnerA,
        role: "owner",
      });

      // Target organization ID from path/query/body is foreign Org B
      expect(() => validateTenantAccess(activeContext, orgBId)).toThrow(TenantAuthorizationError);
      expect(() => validateTenantAccess(activeContext, "org_attacker_forged_999")).toThrow(
        TenantAuthorizationError
      );
    });
  });

  // =========================================================================
  // 2. ORGANIZATION CROSS-TENANT ISOLATION & NON-DISCLOSURE (SECTION 5)
  // =========================================================================
  describe("2. Organization Cross-Tenant Boundaries (Section 5)", () => {
    const ownerAContext: TenantContext = Object.freeze({
      organizationId: orgAId,
      userId: userOwnerA,
      role: "owner",
    });

    it("5.1: Org A user cannot read Org B organization metadata", async () => {
      let errorThrown: unknown;
      try {
        await orgService.getOrganization(ownerAContext, orgBId);
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).toBeInstanceOf(TenantAuthorizationError);
      const res = handleRouteError(errorThrown);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain(orgAId);
      expect(text).not.toContain(orgBId);
    });

    it("5.2: Org A user cannot read Org B settings", async () => {
      let errorThrown: unknown;
      try {
        await orgService.getSettings(ownerAContext, orgBId);
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).toBeInstanceOf(TenantAuthorizationError);
      const res = handleRouteError(errorThrown);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain(orgAId);
      expect(text).not.toContain(orgBId);
    });

    it("5.3: Org A user cannot update Org B settings", async () => {
      let errorThrown: unknown;
      try {
        await orgService.updateSettings(ownerAContext, orgBId, {
          defaultRetentionDays: 999,
        });
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).toBeInstanceOf(TenantAuthorizationError);
      const res = handleRouteError(errorThrown);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain(orgAId);
      expect(text).not.toContain(orgBId);
    });

    it("5.4: Org A user cannot list Org B members", async () => {
      let errorThrown: unknown;
      try {
        await memberService.listMembers(ownerAContext, orgBId);
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).toBeInstanceOf(TenantAuthorizationError);
      const res = handleRouteError(errorThrown);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain(orgAId);
      expect(text).not.toContain(orgBId);
    });

    it("5.5: Org A user cannot update Org B member", async () => {
      let errorThrown: unknown;
      try {
        await memberService.updateMemberRole(ownerAContext, orgBId, memberSciBId, "viewer");
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).toBeInstanceOf(TenantAuthorizationError);
      const res = handleRouteError(errorThrown);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain(orgAId);
      expect(text).not.toContain(orgBId);
    });

    it("5.6: Org A user cannot remove Org B member", async () => {
      let errorThrown: unknown;
      try {
        await memberService.removeMember(ownerAContext, orgBId, memberSciBId);
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).toBeInstanceOf(TenantAuthorizationError);
      const res = handleRouteError(errorThrown);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain(orgAId);
      expect(text).not.toContain(orgBId);
    });

    it("5.7: Org A user cannot list Org B invitations", async () => {
      let errorThrown: unknown;
      try {
        await invitationService.listInvitations(ownerAContext, orgBId);
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).toBeInstanceOf(TenantAuthorizationError);
      const res = handleRouteError(errorThrown);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain(orgAId);
      expect(text).not.toContain(orgBId);
    });

    it("5.8: Org A user cannot create invitation for Org B", async () => {
      let errorThrown: unknown;
      try {
        await invitationService.createInvitation(ownerAContext, orgBId, {
          email: "attacker@cellweave.dev",
          role: "scientist",
        });
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).toBeInstanceOf(TenantAuthorizationError);
      const res = handleRouteError(errorThrown);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain(orgAId);
      expect(text).not.toContain(orgBId);
    });

    it("5.9: Org A user cannot cancel invitation in Org B", async () => {
      let errorThrown: unknown;
      try {
        await invitationService.cancelInvitation(ownerAContext, orgBId, "inv_fake_foreign");
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).toBeInstanceOf(TenantAuthorizationError);
      const res = handleRouteError(errorThrown);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain(orgAId);
      expect(text).not.toContain(orgBId);
    });

    it("5.10: Org A user cannot read Org B audit trail", async () => {
      let errorThrown: unknown;
      try {
        await auditService.listAuditEvents(ownerAContext, orgBId);
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).toBeInstanceOf(TenantAuthorizationError);
      const res = handleRouteError(errorThrown);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain(orgAId);
      expect(text).not.toContain(orgBId);
    });
  });

  // =========================================================================
  // 3. CANONICAL RBAC LIVE INTEGRATION MATRIX (SECTION 6)
  // =========================================================================
  describe("3. Canonical RBAC Matrix (Section 6)", () => {
    const ownerCtx: TenantContext = Object.freeze({
      organizationId: orgAId,
      userId: userOwnerA,
      role: "owner",
    });
    const adminCtx: TenantContext = Object.freeze({
      organizationId: orgAId,
      userId: userAdminA,
      role: "admin",
    });
    const bioCtx: TenantContext = Object.freeze({
      organizationId: orgAId,
      userId: userBioA,
      role: "bioinformatician",
    });
    const sciCtx: TenantContext = Object.freeze({
      organizationId: orgAId,
      userId: userSciA,
      role: "scientist",
    });
    const viewCtx: TenantContext = Object.freeze({
      organizationId: orgAId,
      userId: userViewA,
      role: "viewer",
    });

    it("6.1: Owner can update settings and read audit logs", async () => {
      const updated = await orgService.updateSettings(ownerCtx, orgAId, {
        defaultRetentionDays: 60,
      });
      expect(updated.defaultRetentionDays).toBe(60);

      const events = await auditService.listAuditEvents(ownerCtx, orgAId);
      expect(Array.isArray(events)).toBe(true);
    });

    it("6.2: Admin can update settings", async () => {
      const updated = await orgService.updateSettings(adminCtx, orgAId, {
        defaultRetentionDays: 75,
      });
      expect(updated.defaultRetentionDays).toBe(75);
    });

    it("6.3: Admin cannot read audit events (Owner only)", async () => {
      await expect(auditService.listAuditEvents(adminCtx, orgAId)).rejects.toThrow(
        TenantAuthorizationError
      );
    });

    it("6.4: Admin cannot promote any user to Owner", async () => {
      await expect(
        memberService.updateMemberRole(adminCtx, orgAId, memberSciAId, "owner")
      ).rejects.toThrow(TenantAuthorizationError);
    });

    it("6.5: Admin cannot modify an Owner's role", async () => {
      await expect(
        memberService.updateMemberRole(adminCtx, orgAId, memberOwnerAId, "admin")
      ).rejects.toThrow(TenantAuthorizationError);
    });

    it("6.6: Admin cannot remove an Owner", async () => {
      await expect(memberService.removeMember(adminCtx, orgAId, memberOwnerAId)).rejects.toThrow(
        TenantAuthorizationError
      );
    });

    it("6.7: Non-admin roles (Bioinformatician, Scientist, Viewer) cannot update settings", async () => {
      await expect(
        orgService.updateSettings(bioCtx, orgAId, { defaultRetentionDays: 90 })
      ).rejects.toThrow(TenantAuthorizationError);
      await expect(
        orgService.updateSettings(sciCtx, orgAId, { defaultRetentionDays: 90 })
      ).rejects.toThrow(TenantAuthorizationError);
      await expect(
        orgService.updateSettings(viewCtx, orgAId, { defaultRetentionDays: 90 })
      ).rejects.toThrow(TenantAuthorizationError);
    });

    it("6.8: Non-admin roles cannot manage members or invitations", async () => {
      await expect(
        memberService.updateMemberRole(bioCtx, orgAId, memberSciAId, "viewer")
      ).rejects.toThrow(TenantAuthorizationError);
      await expect(memberService.removeMember(sciCtx, orgAId, memberViewAId)).rejects.toThrow(
        TenantAuthorizationError
      );
      await expect(
        invitationService.createInvitation(viewCtx, orgAId, {
          email: "new@cellweave.dev",
          role: "scientist",
        })
      ).rejects.toThrow(TenantAuthorizationError);
    });

    it("6.9: Non-admin roles cannot assign project members", async () => {
      await expect(
        projectService.assignMemberToProject(bioCtx, projA1Id, userViewA)
      ).rejects.toThrow(TenantAuthorizationError);
      await expect(
        projectService.assignMemberToProject(sciCtx, projA1Id, userViewA)
      ).rejects.toThrow(TenantAuthorizationError);
      await expect(
        projectService.assignMemberToProject(viewCtx, projA1Id, userViewA)
      ).rejects.toThrow(TenantAuthorizationError);
    });
  });

  // =========================================================================
  // 4. MEMBERSHIP ISOLATION (SECTION 7)
  // =========================================================================
  describe("4. Membership Isolation & DB Constraints (Section 7)", () => {
    const ownerACtx: TenantContext = Object.freeze({
      organizationId: orgAId,
      userId: userOwnerA,
      role: "owner",
    });
    const ownerBCtx: TenantContext = Object.freeze({
      organizationId: orgBId,
      userId: userOwnerB,
      role: "owner",
    });

    it("7.1: User A (member of Org A) cannot be targeted as a member in Org B", async () => {
      await expect(
        memberService.updateMemberRole(ownerBCtx, orgBId, memberAdminAId, "viewer")
      ).rejects.toThrow(ResourceNotFoundError);
      await expect(memberService.removeMember(ownerBCtx, orgBId, memberAdminAId)).rejects.toThrow(
        ResourceNotFoundError
      );
    });

    it("7.2: User B (member of Org B) cannot be assigned to Org A project", async () => {
      await expect(
        projectService.assignMemberToProject(ownerACtx, projA1Id, userSciB)
      ).rejects.toThrow(ResourceNotFoundError);
    });

    it("7.3: Duplicate (organizationId, userId) membership is rejected by PostgreSQL unique constraint", async () => {
      await expect(
        db.insert(member).values({
          id: `dev_exit_dup_${testRunId}`,
          organizationId: orgAId,
          userId: userOwnerA, // already member of Org A
          role: "viewer",
          createdAt: new Date(),
        })
      ).rejects.toThrow(/member_organization_user_unique/);
    });

    it("7.4: Invalid role is rejected by DB check constraint member_role_check and domain validation", async () => {
      await expect(
        memberService.updateMemberRole(ownerACtx, orgAId, memberSciAId, "invalid_super_role")
      ).rejects.toThrow(ValidationError);

      // Direct SQL attempt violates member_role_check constraint
      await expect(
        db.insert(member).values({
          id: `dev_exit_invalid_role_${testRunId}`,
          organizationId: orgAId,
          userId: userViewA,
          role: "invalid_role" as OrganizationRole,
          createdAt: new Date(),
        })
      ).rejects.toThrow(/member_role_check/);
    });

    it("7.5: Owner removal is rejected (prevents ownerless organization)", async () => {
      await expect(memberService.removeMember(ownerACtx, orgAId, memberOwnerAId)).rejects.toThrow(
        TenantAuthorizationError
      );
    });
  });

  // =========================================================================
  // 5. PROJECT ACCESS MATRIX & CROSS-TENANT ASSIGNMENTS (SECTIONS 8 & 9)
  // =========================================================================
  describe("5. Project Access Matrix & Assignment Boundaries (Sections 8 & 9)", () => {
    const ownerACtx: TenantContext = Object.freeze({
      organizationId: orgAId,
      userId: userOwnerA,
      role: "owner",
    });
    const adminACtx: TenantContext = Object.freeze({
      organizationId: orgAId,
      userId: userAdminA,
      role: "admin",
    });
    const bioACtx: TenantContext = Object.freeze({
      organizationId: orgAId,
      userId: userBioA,
      role: "bioinformatician",
    });
    const sciACtx: TenantContext = Object.freeze({
      organizationId: orgAId,
      userId: userSciA,
      role: "scientist",
    });
    const viewACtx: TenantContext = Object.freeze({
      organizationId: orgAId,
      userId: userViewA,
      role: "viewer",
    });

    it("8.1: Owner A has organization-wide access to Project A1 without project_members assignment row", async () => {
      const res = await projectService.assertProjectAccess(ownerACtx, projA1Id);
      expect(res.hasAccess).toBe(true);
      expect(res.accessType).toBe("organization_wide");
    });

    it("8.2: Owner A cannot access foreign Project B1 (non-disclosing ResourceNotFoundError)", async () => {
      await expect(projectService.assertProjectAccess(ownerACtx, projB1Id)).rejects.toThrow(
        ResourceNotFoundError
      );
    });

    it("8.3: Admin A has organization-wide access to Project A1 without assignment row", async () => {
      const res = await projectService.assertProjectAccess(adminACtx, projA1Id);
      expect(res.hasAccess).toBe(true);
      expect(res.accessType).toBe("organization_wide");
    });

    it("8.4: Admin A cannot access foreign Project B1", async () => {
      await expect(projectService.assertProjectAccess(adminACtx, projB1Id)).rejects.toThrow(
        ResourceNotFoundError
      );
    });

    it("8.5: Bioinformatician A has access to assigned Project A1, but unassigned Project A2 is denied", async () => {
      // Assigned Project A1 -> allowed
      const resA1 = await projectService.assertProjectAccess(bioACtx, projA1Id);
      expect(resA1.hasAccess).toBe(true);
      expect(resA1.accessType).toBe("project_assignment");

      // Unassigned Project A2 -> denied
      await expect(projectService.assertProjectAccess(bioACtx, projA2Id)).rejects.toThrow(
        TenantAuthorizationError
      );

      // Foreign Project B1 -> non-disclosing 404
      await expect(projectService.assertProjectAccess(bioACtx, projB1Id)).rejects.toThrow(
        ResourceNotFoundError
      );
    });

    it("8.6: Scientist A has access to assigned Project A1, but unassigned Project A2 is denied", async () => {
      const resA1 = await projectService.assertProjectAccess(sciACtx, projA1Id);
      expect(resA1.hasAccess).toBe(true);

      await expect(projectService.assertProjectAccess(sciACtx, projA2Id)).rejects.toThrow(
        TenantAuthorizationError
      );
    });

    it("8.7: Viewer A unassigned to Project A1 is denied access", async () => {
      await expect(projectService.assertProjectAccess(viewACtx, projA1Id)).rejects.toThrow(
        TenantAuthorizationError
      );
    });

    it("9.1: Assign Org B user to Project A1 is denied", async () => {
      await expect(
        projectService.assignMemberToProject(adminACtx, projA1Id, userSciB)
      ).rejects.toThrow(ResourceNotFoundError);
    });

    it("9.2: Assign Org A user to Project B1 is denied (non-disclosing)", async () => {
      await expect(
        projectService.assignMemberToProject(adminACtx, projB1Id, userSciA)
      ).rejects.toThrow(ResourceNotFoundError);
    });

    it("9.3: Remove assignment from foreign Project B1 is denied (non-disclosing)", async () => {
      await expect(
        projectService.removeMemberFromProject(adminACtx, projB1Id, userSciA)
      ).rejects.toThrow(ResourceNotFoundError);
    });

    it("9.4: List foreign Project B1 members is denied (non-disclosing)", async () => {
      await expect(projectService.listProjectMembers(adminACtx, projB1Id)).rejects.toThrow(
        ResourceNotFoundError
      );
    });

    it("9.5: Composite tenant FK project_members_project_org_fk defense-in-depth rejects cross-tenant assignment row", async () => {
      // Direct SQL attempt to assign user to Project A1 under Org B organizationId
      await expect(
        db.insert(projectMembers).values({
          id: `dev_exit_pm_cross_${testRunId}`,
          organizationId: orgBId, // mismatch! projA1 belongs to orgAId
          projectId: projA1Id,
          userId: userSciB,
          createdAt: new Date(),
        })
      ).rejects.toThrow(/project_members_project_org_fk/);
    });
  });

  // =========================================================================
  // 6. SETTINGS ISOLATION (SECTION 10)
  // =========================================================================
  describe("6. Settings Isolation (Section 10)", () => {
    const ownerACtx: TenantContext = Object.freeze({
      organizationId: orgAId,
      userId: userOwnerA,
      role: "owner",
    });

    it("10.1: Org A settings update mutates Org A only, never touching Org B", async () => {
      // Update Org A settings
      await orgService.updateSettings(ownerACtx, orgAId, {
        defaultRetentionDays: 120,
        projectVisibility: "private",
      });

      // Verify Org A in DB
      const orgASettings = await db
        .select()
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, orgAId));
      expect(orgASettings[0]?.defaultRetentionDays).toBe(120);

      // Verify Org B in DB remains completely untouched at 45 days
      const orgBSettings = await db
        .select()
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, orgBId));
      expect(orgBSettings[0]?.defaultRetentionDays).toBe(45);
      expect(orgBSettings[0]?.updatedBy).toBe(userOwnerB);
    });
  });

  // =========================================================================
  // 7. AUDIT ISOLATION & PRIVACY (SECTION 11)
  // =========================================================================
  describe("7. Audit Isolation & Privacy Invariants (Section 11)", () => {
    const ownerACtx: TenantContext = Object.freeze({
      organizationId: orgAId,
      userId: userOwnerA,
      role: "owner",
    });
    const ownerBCtx: TenantContext = Object.freeze({
      organizationId: orgBId,
      userId: userOwnerB,
      role: "owner",
    });
    const adminACtx: TenantContext = Object.freeze({
      organizationId: orgAId,
      userId: userAdminA,
      role: "admin",
    });

    it("11.1 & 11.2 & 11.3: Audit events are strictly tenant-isolated and non-leaking", async () => {
      // 1. Generate controlled audit event in Org A
      await auditService.recordUserAuditEvent({
        context: ownerACtx,
        action: "dev_exit.org_a_action",
        resourceType: "test",
        resourceId: "res_a",
        clientIp: "198.51.100.11",
        userAgent: "ExitTest/1.0",
      });

      // 2. Generate controlled audit event in Org B
      await auditService.recordUserAuditEvent({
        context: ownerBCtx,
        action: "dev_exit.org_b_action",
        resourceType: "test",
        resourceId: "res_b",
        clientIp: "198.51.100.22",
        userAgent: "ExitTest/1.0",
      });

      // 3. Owner A lists audit events: receives Org A events, 0 from Org B
      const orgAEvents = await auditService.listAuditEvents(ownerACtx, orgAId);
      const hasOrgAEvent = orgAEvents.some((e) => e.action === "dev_exit.org_a_action");
      const hasOrgBEvent = orgAEvents.some((e) => e.action === "dev_exit.org_b_action");
      expect(hasOrgAEvent).toBe(true);
      expect(hasOrgBEvent).toBe(false);

      // 4. Owner B lists audit events: receives Org B events, 0 from Org A
      const orgBEvents = await auditService.listAuditEvents(ownerBCtx, orgBId);
      const bHasAEvent = orgBEvents.some((e) => e.action === "dev_exit.org_a_action");
      const bHasBEvent = orgBEvents.some((e) => e.action === "dev_exit.org_b_action");
      expect(bHasAEvent).toBe(false);
      expect(bHasBEvent).toBe(true);

      // 5. Admin A cannot read audit events
      await expect(auditService.listAuditEvents(adminACtx, orgAId)).rejects.toThrow(
        TenantAuthorizationError
      );

      // 6. DB inspection: verify raw IP is NEVER stored
      const rawRows = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.organizationId, orgAId));
      for (const row of rawRows) {
        expect(row.organizationId).toBe(orgAId);
        expect(row.actorType).toBe("user");
        expect(row.ipHash).not.toBe("198.51.100.11");
        expect(JSON.stringify(row)).not.toContain("198.51.100.11");
      }
    });
  });

  // =========================================================================
  // 8. IMMEDIATE MEMBERSHIP REVOCATION TEST (SECTION 12 - MANDATORY)
  // =========================================================================
  describe("8. Immediate Membership Revocation (Section 12)", () => {
    it("12.1-12.4: removing membership denies subsequent requests immediately without re-authenticating", async () => {
      // Create user with active session
      const revUserId = `dev_exit_usr_rev_${testRunId}`;
      const revMemberId = `dev_exit_mem_rev_${testRunId}`;
      const now = new Date();

      await db.insert(user).values({
        id: revUserId,
        name: "Revocation Candidate",
        email: `rev_${testRunId}@cellweave.dev`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(member).values({
        id: revMemberId,
        organizationId: orgAId,
        userId: revUserId,
        role: "bioinformatician",
        createdAt: now,
      });

      const projMemberId = `dev_exit_pm_rev_${testRunId}`;
      await db.insert(projectMembers).values({
        id: projMemberId,
        organizationId: orgAId,
        projectId: projA1Id,
        userId: revUserId,
        createdAt: now,
      });

      // Session remains statically valid with activeOrganizationId = orgAId
      const staticSessionClient = createTestAuthClient({
        user: { id: revUserId, email: `rev_${testRunId}@cellweave.dev` },
        session: {
          id: "sess_rev",
          userId: revUserId,
          activeOrganizationId: orgAId,
        },
      });

      // 1. Initial request succeeds
      const context1 = await resolveTenantContext({
        requestOrHeaders: new Headers(),
        authClient: staticSessionClient,
        dbClient: db,
      });
      const access1 = await projectService.assertProjectAccess(context1, projA1Id);
      expect(access1.hasAccess).toBe(true);

      // 2. Owner removes organization membership
      await db.delete(member).where(eq(member.id, revMemberId));

      // 3. Repeat request WITHOUT re-authenticating
      let errorThrown: unknown;
      try {
        await resolveTenantContext({
          requestOrHeaders: new Headers(),
          authClient: staticSessionClient,
          dbClient: db,
        });
      } catch (err) {
        errorThrown = err;
      }

      // Access is denied immediately: stale session does NOT preserve tenant access
      expect(errorThrown).toBeInstanceOf(TenantMembershipNotFoundError);

      // Cleanup
      await db.delete(projectMembers).where(eq(projectMembers.id, projMemberId));
      await db.delete(user).where(eq(user.id, revUserId));
    });
  });

  // =========================================================================
  // 9. IMMEDIATE ROLE-DOWNGRADE TEST (SECTION 13)
  // =========================================================================
  describe("9. Immediate Role Downgrade (Section 13)", () => {
    it("13.1-13.4: downgrading Admin to Viewer denies admin mutations immediately without recreating session", async () => {
      const downUserId = `dev_exit_usr_down_${testRunId}`;
      const downMemberId = `dev_exit_mem_down_${testRunId}`;
      const now = new Date();

      await db.insert(user).values({
        id: downUserId,
        name: "Downgrade Candidate",
        email: `down_${testRunId}@cellweave.dev`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(member).values({
        id: downMemberId,
        organizationId: orgAId,
        userId: downUserId,
        role: "admin",
        createdAt: now,
      });

      const sessionClient = createTestAuthClient({
        user: { id: downUserId, email: `down_${testRunId}@cellweave.dev` },
        session: {
          id: "sess_down",
          userId: downUserId,
          activeOrganizationId: orgAId,
        },
      });

      // 1. When Admin, settings update succeeds
      const contextAdmin = await resolveTenantContext({
        requestOrHeaders: new Headers(),
        authClient: sessionClient,
        dbClient: db,
      });
      expect(contextAdmin.role).toBe("admin");

      const updateResult = await orgService.updateSettings(contextAdmin, orgAId, {
        defaultRetentionDays: 90,
      });
      expect(updateResult.defaultRetentionDays).toBe(90);

      // 2. Owner downgrades role to 'viewer' in real PostgreSQL
      await db.update(member).set({ role: "viewer" }).where(eq(member.id, downMemberId));

      // 3. Without recreating session: resolve context again
      const contextViewer = await resolveTenantContext({
        requestOrHeaders: new Headers(),
        authClient: sessionClient,
        dbClient: db,
      });
      expect(contextViewer.role).toBe("viewer");

      // 4. Attempt same admin mutation: denied immediately
      await expect(
        orgService.updateSettings(contextViewer, orgAId, {
          defaultRetentionDays: 100,
        })
      ).rejects.toThrow(TenantAuthorizationError);

      // Cleanup
      await db.delete(member).where(eq(member.id, downMemberId));
      await db.delete(user).where(eq(user.id, downUserId));
    });
  });

  // =========================================================================
  // 10. IMMEDIATE PROJECT ASSIGNMENT REVOCATION (SECTION 14)
  // =========================================================================
  describe("10. Immediate Project Assignment Revocation (Section 14)", () => {
    it("14.1-14.4: removing project assignment denies project access immediately", async () => {
      const sciContext: TenantContext = Object.freeze({
        organizationId: orgAId,
        userId: userSciA,
        role: "scientist",
      });

      // 1. Initially assigned to Project A1 -> access allowed
      const res1 = await projectService.assertProjectAccess(sciContext, projA1Id);
      expect(res1.hasAccess).toBe(true);

      // 2. Admin removes project assignment
      await db.delete(projectMembers).where(eq(projectMembers.id, projMemberSciA1Id));

      // 3. Repeat request without re-authenticating -> access denied immediately
      await expect(projectService.assertProjectAccess(sciContext, projA1Id)).rejects.toThrow(
        TenantAuthorizationError
      );

      // Re-insert assignment for cleanup consistency
      await db.insert(projectMembers).values({
        id: projMemberSciA1Id,
        organizationId: orgAId,
        projectId: projA1Id,
        userId: userSciA,
        createdAt: new Date(),
      });
    });
  });

  // =========================================================================
  // 11. ACTIVE-ORGANIZATION SWITCHING (SECTION 15)
  // =========================================================================
  describe("11. Active Organization Switching (Section 15)", () => {
    it("15.1-15.4: multi-org member resolves fresh TenantContext matching activeOrganizationId", async () => {
      // multiUser is legitimate member of both Org A and Org B
      // Active Org A
      const clientOrgA = createTestAuthClient({
        user: { id: userMulti, email: `multi_${testRunId}@cellweave.dev` },
        session: {
          id: "sess_multi",
          userId: userMulti,
          activeOrganizationId: orgAId,
        },
      });

      const contextA = await resolveTenantContext({
        requestOrHeaders: new Headers(),
        authClient: clientOrgA,
        dbClient: db,
      });
      expect(contextA.organizationId).toBe(orgAId);

      // Switch active org to Org B
      const clientOrgB = createTestAuthClient({
        user: { id: userMulti, email: `multi_${testRunId}@cellweave.dev` },
        session: {
          id: "sess_multi",
          userId: userMulti,
          activeOrganizationId: orgBId,
        },
      });

      const contextB = await resolveTenantContext({
        requestOrHeaders: new Headers(),
        authClient: clientOrgB,
        dbClient: db,
      });
      expect(contextB.organizationId).toBe(orgBId);

      // Cannot combine Org A context + Org B target
      expect(() => validateTenantAccess(contextA, orgBId)).toThrow(TenantAuthorizationError);
    });
  });

  // =========================================================================
  // 12. DATABASE DEFENSE-IN-DEPTH CHECKS (SECTION 16)
  // =========================================================================
  describe("12. Database Defense-in-Depth Checks (Section 16)", () => {
    it("16.1-16.4: PostgreSQL constraints exist in live DEV database", async () => {
      const constraints = await db.execute<{
        conname: string;
        contype: string;
      }>(`
        SELECT conname, contype
        FROM pg_constraint
        WHERE conname IN (
          'member_organization_user_unique',
          'member_role_check',
          'project_members_project_org_fk',
          'project_members_project_user_unique'
        )
      `);

      const names = constraints.rows.map((r) => r.conname);
      expect(names).toContain("member_organization_user_unique");
      expect(names).toContain("member_role_check");
      expect(names).toContain("project_members_project_org_fk");
      expect(names).toContain("project_members_project_user_unique");
    });

    it("16.5 & 16.6: audit_events runtime UPDATE and DELETE are strictly denied by PostgreSQL permissions", async () => {
      // UPDATE denied
      await expect(
        db.execute(`UPDATE audit_events SET action = 'tampered' WHERE id = 'nonexistent'`)
      ).rejects.toThrow(/permission denied for table audit_events/);

      // DELETE denied
      await expect(db.execute(`DELETE FROM audit_events WHERE id = 'nonexistent'`)).rejects.toThrow(
        /permission denied for table audit_events/
      );
    });

    it("16.7: cellweave_app_runtime role has no elevated privileges and owns zero tables", async () => {
      const roles = await db.execute<{
        rolname: string;
        rolsuper: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
      }>(`
        SELECT rolname, rolsuper, rolcreaterole, rolcreatedb
        FROM pg_roles
        WHERE rolname = 'cellweave_app_runtime'
      `);

      expect(roles.rows[0]?.rolsuper).toBe(false);
      expect(roles.rows[0]?.rolcreaterole).toBe(false);
      expect(roles.rows[0]?.rolcreatedb).toBe(false);

      const ownedTables = await db.execute<{
        tablename: string;
        tableowner: string;
      }>(`
        SELECT tablename, tableowner
        FROM pg_tables
        WHERE schemaname = 'public' AND tableowner = 'cellweave_app_runtime'
      `);

      expect(ownedTables.rows.length).toBe(0);
    });
  });

  // =========================================================================
  // 13. HTTP NON-DISCLOSURE VERIFICATION (SECTION 17)
  // =========================================================================
  describe("13. HTTP Non-Disclosure Responses (Section 17)", () => {
    it("17.1: Foreign targets produce generic non-disclosing 403 or 404 responses", async () => {
      // Cross-tenant attempt
      const crossErr = new TenantAuthorizationError("Cross-tenant access prohibited");
      const res403 = handleRouteError(crossErr);
      expect(res403.status).toBe(403);
      const body403 = (await res403.json()) as { error: string; message: string };
      expect(body403).toEqual({
        error: "FORBIDDEN",
        message: "You are not authorized to access this resource.",
      });

      // Missing resource attempt
      const notFoundErr = new ResourceNotFoundError("Project not found");
      const res404 = handleRouteError(notFoundErr);
      expect(res404.status).toBe(404);
      const body404 = (await res404.json()) as { error: string; message: string };
      expect(body404).toEqual({
        error: "NOT_FOUND",
        message: "Resource not found",
      });
    });
  });
});

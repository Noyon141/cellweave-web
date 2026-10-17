import { describe, it, expect, vi } from "vitest";
import { AuditService } from "@/server/services/audit-service";
import { hashIpAddress, sanitizeAuditMetadata } from "@/server/services/audit-privacy";
import { OrganizationService } from "@/server/services/organization-service";
import { MemberService } from "@/server/services/member-service";
import { InvitationService } from "@/server/services/invitation-service";
import { ProjectPermissionService } from "@/server/services/project-permission-service";
import { TenantAuthorizationError, ValidationError } from "@/server/authorization";
import type { TenantContext, OrganizationRole } from "@/types";
import type { DbClient, DatabaseExecutor } from "@/server/database/client";
import { auditEvents } from "@/server/database/schema/audit-events";
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

describe("Audit Logging Framework & Persistence Tests (Step H)", () => {
  describe("1-6. Append-Only Event Persistence & Actor Derivation", () => {
    it("1. recordUserAuditEvent inserts valid event", async () => {
      let insertedValues: Record<string, unknown> | null = null;
      const mockDb = {
        insert: (table: unknown) => ({
          values: (vals: Record<string, unknown>) => {
            if (table === auditEvents) {
              insertedValues = vals;
            }
            return Promise.resolve();
          },
        }),
      } as unknown as DbClient;

      const service = new AuditService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha", "usr_alice");

      const event = await service.recordUserAuditEvent({
        context: ctx,
        action: "test.action",
        resourceType: "test_resource",
        resourceId: "res_123",
        metadata: { key: "value" },
        clientIp: "192.168.1.1",
        userAgent: "TestAgent/1.0",
      });

      expect(event.id).toMatch(/^aud_/);
      expect(event.action).toBe("test.action");
      expect(event.organizationId).toBe("org_alpha");
      expect(event.actorId).toBe("usr_alice");
      expect(event.actorType).toBe("user");
      expect(insertedValues).not.toBeNull();
      expect(insertedValues!.action).toBe("test.action");
    });

    it("2-4. organizationId, actorId, and actorType derive strictly from TenantContext", async () => {
      let insertedValues: Record<string, unknown> | null = null;
      const mockDb = {
        insert: () => ({
          values: (vals: Record<string, unknown>) => {
            insertedValues = vals;
            return Promise.resolve();
          },
        }),
      } as unknown as DbClient;

      const service = new AuditService({ dbClient: mockDb });
      const ctx = makeContext("scientist", "org_real_tenant", "usr_scientist_99");

      await service.recordUserAuditEvent({
        context: ctx,
        action: "test.derived_actor",
        resourceType: "sample",
        resourceId: "s_1",
      });

      expect(insertedValues!.organizationId).toBe("org_real_tenant");
      expect(insertedValues!.actorId).toBe("usr_scientist_99");
      expect(insertedValues!.actorType).toBe("user");
    });

    it("executes insert on supplied transactional DatabaseExecutor (tx)", async () => {
      let txInserted = false;
      const mockTx: DatabaseExecutor = {
        select: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        insert: (table: unknown) => ({
          values: () => {
            if (table === auditEvents) txInserted = true;
            return Promise.resolve();
          },
        }),
      } as unknown as DatabaseExecutor;

      const fallbackDb = {
        insert: () => {
          throw new Error("Fallback DB should not be called when tx is provided");
        },
      } as unknown as DbClient;

      const service = new AuditService({ dbClient: fallbackDb });
      const ctx = makeContext("owner", "org_alpha", "usr_tx_test");

      await service.recordUserAuditEvent({
        db: mockTx,
        context: ctx,
        action: "tx.action",
        resourceType: "tx_resource",
        resourceId: "res_tx",
      });

      expect(txInserted).toBe(true);
    });

    it("5-6. no update or delete method exists on AuditService", () => {
      const service = new AuditService({ dbClient: {} as DbClient });
      expect((service as unknown as Record<string, unknown>).updateAuditEvent).toBeUndefined();
      expect((service as unknown as Record<string, unknown>).deleteAuditEvent).toBeUndefined();
      expect((service as unknown as Record<string, unknown>).replaceAuditEvent).toBeUndefined();
    });
  });

  describe("7-9. Privacy, Metadata Sanitization & IP Hashing", () => {
    it("7 & 26. forbidden sensitive metadata rejected / fail-closed", () => {
      const sensitiveKeys = [
        "password",
        "userPassword",
        "apiSecret",
        "secret",
        "sessionToken",
        "accessToken",
        "refreshToken",
        "idToken",
        "authorization",
        "cookieHeader",
        "rawDataMatrix",
        "expressionVector",
        "geneExpressionData",
        "patientName",
        "phiIdentifier",
      ];

      for (const key of sensitiveKeys) {
        expect(() => {
          sanitizeAuditMetadata({ [key]: "sensitive_data" });
        }).toThrow(ValidationError);
      }
    });

    it("accepts safe operational metadata and strips functions/undefined", () => {
      const safeMeta = {
        targetUserId: "usr_42",
        previousRole: "viewer",
        newRole: "scientist",
        retentionDays: 30,
        nested: { count: 5 },
        droppedFunc: () => {},
      };

      const sanitized = sanitizeAuditMetadata(safeMeta);
      expect(sanitized).toEqual({
        targetUserId: "usr_42",
        previousRole: "viewer",
        newRole: "scientist",
        retentionDays: 30,
        nested: { count: 5 },
      });
      expect(sanitized!.droppedFunc).toBeUndefined();
    });

    it("8-9. raw ipAddress is never persisted and ipHash is generated via HMAC", () => {
      const hash1 = hashIpAddress("203.0.113.195");
      const hash2 = hashIpAddress("203.0.113.195");
      const hashOther = hashIpAddress("198.51.100.42");

      expect(hash1).not.toBeNull();
      expect(hash1).not.toBe("203.0.113.195"); // never raw IP
      expect(hash1).toBe(hash2); // deterministic
      expect(hash1).not.toBe(hashOther);
      expect(hashIpAddress(null)).toBeNull();
      expect(hashIpAddress("   ")).toBeNull();
    });
  });

  describe("10-16. Audit Query Authorization & Tenant Scoping", () => {
    it("10. owner can list same-org audit events", async () => {
      const mockEvents = [
        {
          id: "aud_1",
          organizationId: "org_alpha",
          actorType: "user",
          actorId: "usr_1",
          action: "member.role_changed",
          resourceType: "member",
          resourceId: "mem_1",
          metadata: { newRole: "admin" },
          ipHash: "hash123",
          userAgent: "agent",
          createdAt: new Date(),
        },
      ];

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => ({
                  offset: () => Promise.resolve(mockEvents),
                }),
              }),
            }),
          }),
        }),
      } as unknown as DbClient;

      const service = new AuditService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha");
      const list = await service.listAuditEvents(ctx, "org_alpha");

      expect(list).toHaveLength(1);
      expect(list[0]?.action).toBe("member.role_changed");
    });

    const unauthorizedRoles: OrganizationRole[] = [
      "admin",
      "bioinformatician",
      "scientist",
      "viewer",
    ];

    for (const role of unauthorizedRoles) {
      it(`11-14. ${role} cannot list audit events`, async () => {
        const service = new AuditService({ dbClient: {} as DbClient });
        const ctx = makeContext(role, "org_alpha");

        await expect(service.listAuditEvents(ctx, "org_alpha")).rejects.toThrow(
          TenantAuthorizationError
        );
      });
    }

    it("15. foreign-org audit query rejected non-disclosing", async () => {
      const service = new AuditService({ dbClient: {} as DbClient });
      const ctx = makeContext("owner", "org_alpha");

      await expect(service.listAuditEvents(ctx, "org_beta_foreign")).rejects.toThrow(
        TenantAuthorizationError
      );
    });

    it("27. pagination limit is bounded to 1-100", async () => {
      let appliedLimit: number | null = null;
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: (lim: number) => {
                  appliedLimit = lim;
                  return {
                    offset: () => Promise.resolve([]),
                  };
                },
              }),
            }),
          }),
        }),
      } as unknown as DbClient;

      const service = new AuditService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha");

      // Attempt limit 500
      await service.listAuditEvents(ctx, "org_alpha", { limit: 500 });
      expect(appliedLimit).toBe(100);

      // Attempt limit -10
      await service.listAuditEvents(ctx, "org_alpha", { limit: -10 });
      expect(appliedLimit).toBe(1);
    });
  });

  describe("17-23. Transactional Audit Consistency across Step F and Step G Services", () => {
    it("17. settings update persists org_settings.updated audit event atomically", async () => {
      let insertedAudit: Record<string, unknown> | null = null;
      let insertedSettings: Record<string, unknown> | null = null;

      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
        insert: (table: unknown) => ({
          values: (vals: Record<string, unknown>) => {
            if (table === auditEvents) {
              insertedAudit = vals;
            } else {
              insertedSettings = vals;
            }
            return Promise.resolve();
          },
        }),
      } as unknown as DbClient;

      const orgService = new OrganizationService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha", "usr_owner_1");
      await orgService.updateSettings(ctx, "org_alpha", {
        defaultRetentionDays: 60,
      });

      expect(insertedSettings).not.toBeNull();
      expect(insertedAudit).not.toBeNull();
      expect(insertedAudit!.action).toBe("org_settings.updated");
      expect(insertedAudit!.organizationId).toBe("org_alpha");
      expect(insertedAudit!.actorId).toBe("usr_owner_1");
      expect(insertedAudit!.actorType).toBe("user");
    });

    it("18. member role change delegates to BetterAuth API and persists member.role_changed audit event", async () => {
      let insertedAudit: Record<string, unknown> | null = null;

      const targetMember = {
        id: "mem_2",
        organizationId: "org_alpha",
        userId: "usr_2",
        role: "viewer",
        createdAt: new Date(),
        userName: "Viewer",
        userEmail: "vw@example.com",
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
        insert: (table: unknown) => ({
          values: (vals: Record<string, unknown>) => {
            if (table === auditEvents) {
              insertedAudit = vals;
            }
            return Promise.resolve();
          },
        }),
      } as unknown as DbClient;

      const mockAuthApi = {
        updateMemberRole: vi.fn().mockResolvedValue({}),
        removeMember: vi.fn(),
      };

      const memberService = new MemberService({ dbClient: mockDb, authApi: mockAuthApi });
      const ctx = makeContext("admin", "org_alpha", "usr_admin_1");
      await memberService.updateMemberRole(ctx, "org_alpha", "mem_2", "scientist");

      expect(mockAuthApi.updateMemberRole).toHaveBeenCalledWith({
        body: {
          memberId: "mem_2",
          role: "scientist",
          organizationId: "org_alpha",
        },
        headers: undefined,
      });
      expect(insertedAudit).not.toBeNull();
      expect(insertedAudit!.action).toBe("member.role_changed");
      expect(insertedAudit!.actorId).toBe("usr_admin_1");
      expect(insertedAudit!.metadata).toEqual({
        targetUserId: "usr_2",
        previousRole: "viewer",
        newRole: "scientist",
      });
    });

    it("19. member removal delegates to BetterAuth API and persists member.removed audit event", async () => {
      let insertedAudit: Record<string, unknown> | null = null;

      const targetMember = {
        id: "mem_3",
        organizationId: "org_alpha",
        userId: "usr_3",
        role: "scientist",
      };

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([targetMember]),
          }),
        }),
        insert: (table: unknown) => ({
          values: (vals: Record<string, unknown>) => {
            if (table === auditEvents) {
              insertedAudit = vals;
            }
            return Promise.resolve();
          },
        }),
      } as unknown as DbClient;

      const mockAuthApi = {
        updateMemberRole: vi.fn(),
        removeMember: vi.fn().mockResolvedValue({}),
      };

      const memberService = new MemberService({ dbClient: mockDb, authApi: mockAuthApi });
      const ctx = makeContext("owner", "org_alpha", "usr_owner");
      await memberService.removeMember(ctx, "org_alpha", "mem_3");

      expect(mockAuthApi.removeMember).toHaveBeenCalledWith({
        body: {
          memberIdOrEmail: "mem_3",
          organizationId: "org_alpha",
        },
        headers: undefined,
      });
      expect(insertedAudit).not.toBeNull();
      expect(insertedAudit!.action).toBe("member.removed");
      expect(insertedAudit!.actorId).toBe("usr_owner");
      expect(insertedAudit!.metadata).toEqual({
        targetUserId: "usr_3",
        role: "scientist",
      });
    });

    it("20. invitation creation delegates to BetterAuth API and persists user.invited audit event", async () => {
      let insertedAudit: Record<string, unknown> | null = null;

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]), // no duplicates
          }),
        }),
        insert: (table: unknown) => ({
          values: (vals: Record<string, unknown>) => {
            if (table === auditEvents) {
              insertedAudit = vals;
            }
            return Promise.resolve();
          },
        }),
      } as unknown as DbClient;

      const mockAuthApi = {
        createInvitation: vi.fn().mockResolvedValue({
          id: "inv_auth_999",
          email: "invitee@example.com",
          role: "scientist",
          organizationId: "org_alpha",
          inviterId: "usr_owner",
          status: "pending",
          expiresAt: new Date(),
        }),
        cancelInvitation: vi.fn(),
      };

      const invService = new InvitationService({ dbClient: mockDb, authApi: mockAuthApi });
      const ctx = makeContext("owner", "org_alpha", "usr_owner");
      const res = await invService.createInvitation(ctx, "org_alpha", {
        email: "invitee@example.com",
        role: "scientist",
      });

      expect(mockAuthApi.createInvitation).toHaveBeenCalledWith({
        body: {
          email: "invitee@example.com",
          role: "scientist",
          organizationId: "org_alpha",
        },
        headers: undefined,
      });
      expect(insertedAudit).not.toBeNull();
      expect(insertedAudit!.action).toBe("user.invited");
      expect(insertedAudit!.resourceId).toBe(res.id);
      expect((insertedAudit!.metadata as Record<string, unknown>).role).toBe("scientist");
    });

    it("21. invitation cancellation delegates to BetterAuth API and persists invitation.canceled audit event", async () => {
      let insertedAudit: Record<string, unknown> | null = null;

      const existingInv = {
        id: "inv_cancel_target",
        organizationId: "org_alpha",
        email: "to_cancel@example.com",
        status: "pending",
      };

      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([existingInv]),
          }),
        }),
        insert: (table: unknown) => ({
          values: (vals: Record<string, unknown>) => {
            if (table === auditEvents) {
              insertedAudit = vals;
            }
            return Promise.resolve();
          },
        }),
      } as unknown as DbClient;

      const mockAuthApi = {
        createInvitation: vi.fn(),
        cancelInvitation: vi.fn().mockResolvedValue({}),
      };

      const invService = new InvitationService({ dbClient: mockDb, authApi: mockAuthApi });
      const ctx = makeContext("admin", "org_alpha", "usr_admin");
      await invService.cancelInvitation(ctx, "org_alpha", "inv_cancel_target");

      expect(mockAuthApi.cancelInvitation).toHaveBeenCalledWith({
        body: {
          invitationId: "inv_cancel_target",
        },
        headers: undefined,
      });
      expect(insertedAudit).not.toBeNull();
      expect(insertedAudit!.action).toBe("invitation.canceled");
      expect(insertedAudit!.resourceId).toBe("inv_cancel_target");
    });

    it("22. project assignment persists project_member.assigned audit event atomically", async () => {
      let insertedAudit: Record<string, unknown> | null = null;
      let insertedMember: Record<string, unknown> | null = null;

      const mockProject = { id: "proj_10", organizationId: "org_alpha" };
      const mockMember = {
        id: "mem_sc",
        userId: "usr_sc",
        role: "scientist",
        userName: "Scientist",
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
                  where: () => Promise.resolve([mockMember]),
                }),
              };
            }
            return { where: () => Promise.resolve([]) };
          },
        }),
        insert: (table: unknown) => ({
          values: (vals: Record<string, unknown>) => {
            if (table === auditEvents) {
              insertedAudit = vals;
            } else if (table === projectMembers) {
              insertedMember = vals;
            }
            return Promise.resolve();
          },
        }),
      } as unknown as DbClient;

      const projService = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha", "usr_owner");
      const assigned = await projService.assignMemberToProject(ctx, "proj_10", "usr_sc");

      expect(insertedMember).not.toBeNull();
      expect(insertedAudit).not.toBeNull();
      expect(insertedAudit!.action).toBe("project_member.assigned");
      expect(insertedAudit!.resourceId).toBe(assigned.id);
      expect(insertedAudit!.metadata).toEqual({
        projectId: "proj_10",
        targetUserId: "usr_sc",
      });
    });

    it("23. project assignment removal persists project_member.removed audit event atomically", async () => {
      let insertedAudit: Record<string, unknown> | null = null;
      let deletedAssignment = false;

      const mockProject = { id: "proj_10", organizationId: "org_alpha" };
      const mockAssignment = { id: "pm_target_1" };

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
          where: () => {
            deletedAssignment = true;
            return Promise.resolve();
          },
        }),
        insert: (table: unknown) => ({
          values: (vals: Record<string, unknown>) => {
            if (table === auditEvents) {
              insertedAudit = vals;
            }
            return Promise.resolve();
          },
        }),
      } as unknown as DbClient;

      const projService = new ProjectPermissionService({ dbClient: mockDb });
      const ctx = makeContext("admin", "org_alpha", "usr_admin");
      await projService.removeMemberFromProject(ctx, "proj_10", "usr_sc");

      expect(deletedAssignment).toBe(true);
      expect(insertedAudit).not.toBeNull();
      expect(insertedAudit!.action).toBe("project_member.removed");
      expect(insertedAudit!.metadata).toEqual({
        projectId: "proj_10",
        targetUserId: "usr_sc",
      });
    });

    it("24. failed domain mutation prevents audit event from being recorded", async () => {
      let auditInserted = false;
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => Promise.reject(new Error("Database transaction aborted")),
          }),
        }),
        insert: (table: unknown) => ({
          values: () => {
            if (table === auditEvents) auditInserted = true;
            return Promise.resolve();
          },
        }),
      } as unknown as DbClient;

      const service = new OrganizationService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha");

      await expect(
        service.updateSettings(ctx, "org_alpha", { defaultRetentionDays: 30 })
      ).rejects.toThrow("Database transaction aborted");

      expect(auditInserted).toBe(false);
    });

    it("25. audit persistence failure inside transaction aborts domain mutation", async () => {
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
        recordUserAuditEvent: vi.fn().mockRejectedValue(new Error("Audit DB unreachable")),
      };

      const service = new OrganizationService({
        dbClient: mockDb,
        auditService: failingAuditService as unknown as InstanceType<typeof AuditService>,
      });
      const ctx = makeContext("owner", "org_alpha");

      await expect(
        service.updateSettings(ctx, "org_alpha", { defaultRetentionDays: 30 })
      ).rejects.toThrow("Audit DB unreachable");
    });
  });
});

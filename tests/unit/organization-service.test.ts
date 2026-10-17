import { describe, it, expect, vi } from "vitest";
import {
  OrganizationService,
  updateOrganizationSettingsSchema,
} from "@/server/services/organization-service";
import { TenantAuthorizationError } from "@/server/authorization";
import type { TenantContext, OrganizationRole } from "@/types";
import type { DbClient } from "@/server/database/client";
import { auditEvents } from "@/server/database/schema/audit-events";

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

describe("Organization Settings Application Service Tests (Step F)", () => {
  describe("Read Authorization across all 5 canonical roles", () => {
    const roles: OrganizationRole[] = ["owner", "admin", "bioinformatician", "scientist", "viewer"];

    for (const role of roles) {
      it(`${role} can read organization settings`, async () => {
        const mockSettings = {
          organizationId: "org_alpha",
          defaultRetentionDays: 30,
          downloadPermissions: "anyone",
          exportPermissions: "anyone",
          projectVisibility: "private",
          updatedAt: new Date(),
          updatedBy: "usr_1",
        };

        const mockDb = {
          select: () => ({
            from: () => ({
              where: () => Promise.resolve([mockSettings]),
            }),
          }),
        } as unknown as DbClient;

        const service = new OrganizationService({ dbClient: mockDb });
        const ctx = makeContext(role);
        const settings = await service.getSettings(ctx, "org_alpha");

        expect(settings).toEqual(mockSettings);
      });
    }
  });

  describe("Update Authorization", () => {
    it("owner can update settings", async () => {
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]), // upsert insert branch
          }),
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as DbClient;

      const service = new OrganizationService({ dbClient: mockDb });
      const ctx = makeContext("owner");
      const updated = await service.updateSettings(ctx, "org_alpha", {
        defaultRetentionDays: 60,
      });

      expect(updated.defaultRetentionDays).toBe(60);
      expect(updated.updatedBy).toBe("usr_actor");
    });

    it("admin can update settings", async () => {
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

      const service = new OrganizationService({ dbClient: mockDb });
      const ctx = makeContext("admin");
      const updated = await service.updateSettings(ctx, "org_alpha", {
        defaultRetentionDays: 90,
      });

      expect(updated.defaultRetentionDays).toBe(90);
      expect(updated.updatedBy).toBe("usr_actor");
    });

    const unauthorizedRoles: OrganizationRole[] = ["bioinformatician", "scientist", "viewer"];

    for (const role of unauthorizedRoles) {
      it(`${role} update is strictly denied`, async () => {
        const service = new OrganizationService({ dbClient: {} as DbClient });
        const ctx = makeContext(role);

        await expect(
          service.updateSettings(ctx, "org_alpha", {
            defaultRetentionDays: 45,
          })
        ).rejects.toThrow(TenantAuthorizationError);
      });
    }
  });

  describe("Deterministic Upsert & Metadata Invariants", () => {
    it("missing settings row upserts safely on insert branch", async () => {
      let insertedValues: Record<string, unknown> | null = null;
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]), // no existing row
          }),
        }),
        insert: (table?: unknown) => ({
          values: (vals: Record<string, unknown>) => {
            if (table !== auditEvents) {
              insertedValues = vals;
            }
            return Promise.resolve();
          },
        }),
      } as unknown as DbClient;

      const service = new OrganizationService({ dbClient: mockDb });
      const ctx = makeContext("admin", "org_alpha", "usr_actor_42");
      const res = await service.updateSettings(ctx, "org_alpha", {
        defaultRetentionDays: 15,
        downloadPermissions: "restricted",
      });

      expect(res.organizationId).toBe("org_alpha");
      expect(res.updatedBy).toBe("usr_actor_42");
      expect(insertedValues).not.toBeNull();
      expect(insertedValues!.organizationId).toBe("org_alpha");
      expect(insertedValues!.updatedBy).toBe("usr_actor_42");
    });

    it("existing settings row updates safely on update branch", async () => {
      const existing = {
        organizationId: "org_alpha",
        defaultRetentionDays: 10,
        downloadPermissions: "old_perm",
        exportPermissions: "old_export",
        projectVisibility: "private",
        updatedAt: new Date("2026-01-01"),
        updatedBy: "usr_old",
      };

      let updatedValues: Record<string, unknown> | null = null;
      const mockDb = {
        transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb),
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([existing]),
          }),
        }),
        update: () => ({
          set: (vals: Record<string, unknown>) => ({
            where: () => {
              updatedValues = vals;
              return Promise.resolve();
            },
          }),
        }),
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as DbClient;

      const service = new OrganizationService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha", "usr_new_updater");
      const res = await service.updateSettings(ctx, "org_alpha", {
        defaultRetentionDays: 45,
      });

      expect(res.defaultRetentionDays).toBe(45);
      expect(res.downloadPermissions).toBe("old_perm"); // preserved
      expect(res.updatedBy).toBe("usr_new_updater");
      expect(updatedValues!.defaultRetentionDays).toBe(45);
      expect(updatedValues!.updatedBy).toBe("usr_new_updater");
    });

    it("organizationId in input cannot override TenantContext (body override immunity)", async () => {
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

      const service = new OrganizationService({ dbClient: mockDb });
      const ctx = makeContext("owner", "org_alpha");

      // Attempt body spoofing
      const inputWithSpoof = {
        defaultRetentionDays: 30,
        organizationId: "org_beta_foreign",
      } as unknown as { defaultRetentionDays: number };

      const res = await service.updateSettings(ctx, "org_alpha", inputWithSpoof);
      expect(res.organizationId).toBe("org_alpha");
      expect(res.organizationId).not.toBe("org_beta_foreign");
    });

    it("foreign organization settings cannot be accessed (IDOR prevention)", async () => {
      const service = new OrganizationService({ dbClient: {} as DbClient });
      const ctx = makeContext("owner", "org_alpha");

      await expect(service.getSettings(ctx, "org_beta_foreign")).rejects.toThrow(
        TenantAuthorizationError
      );

      await expect(
        service.updateSettings(ctx, "org_beta_foreign", { defaultRetentionDays: 30 })
      ).rejects.toThrow(TenantAuthorizationError);
    });

    it("triggers audit hook on update", async () => {
      const auditHook = vi.fn();
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

      const service = new OrganizationService({ dbClient: mockDb, auditHook });
      const ctx = makeContext("owner", "org_alpha", "usr_auditor");
      await service.updateSettings(ctx, "org_alpha", { defaultRetentionDays: 30 });

      expect(auditHook).toHaveBeenCalledTimes(1);
      expect(auditHook).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "org_settings.updated",
          organizationId: "org_alpha",
          actorId: "usr_auditor",
        })
      );
    });

    it("rolls back mutation when transactional audit persistence fails", async () => {
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

      const mockFailingAuditService = {
        recordUserAuditEvent: vi.fn().mockRejectedValue(new Error("Audit DB unreachable")),
      };

      const service = new OrganizationService({
        dbClient: mockDb,
        auditService: mockFailingAuditService as unknown as InstanceType<
          typeof import("@/server/services/audit-service").AuditService
        >,
      });
      const ctx = makeContext("owner", "org_alpha");

      await expect(
        service.updateSettings(ctx, "org_alpha", { defaultRetentionDays: 30 })
      ).rejects.toThrow("Audit DB unreachable");
    });
  });

  describe("Validation Rules", () => {
    it("rejects non-positive defaultRetentionDays", () => {
      expect(() => updateOrganizationSettingsSchema.parse({ defaultRetentionDays: 0 })).toThrow();
      expect(() => updateOrganizationSettingsSchema.parse({ defaultRetentionDays: -5 })).toThrow();
      expect(() =>
        updateOrganizationSettingsSchema.parse({ defaultRetentionDays: 3.14 })
      ).toThrow();
    });

    it("accepts valid positive integer and null retention days", () => {
      expect(updateOrganizationSettingsSchema.parse({ defaultRetentionDays: 30 })).toEqual({
        defaultRetentionDays: 30,
      });
      expect(updateOrganizationSettingsSchema.parse({ defaultRetentionDays: null })).toEqual({
        defaultRetentionDays: null,
      });
    });
  });
});

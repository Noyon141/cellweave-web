import { eq } from "drizzle-orm";
import { z } from "zod";
import type { TenantContext } from "@/types";
import { getDb, type DbClient } from "../database/client";
import { organizationSettings } from "../database/schema/organizations";
import { organization } from "../database/schema/auth";
import { assertOrgAdmin } from "../authorization/guards";
import { ResourceNotFoundError, ValidationError, validateTenantAccess } from "../authorization";
import { AuditService } from "./audit-service";

/**
 * Audit Hook Point Event Definitions for Phase 1 Step F
 * (Persistent logging will be implemented in Step H)
 */
export interface OrganizationSettingsUpdatedEvent {
  eventType: "org_settings.updated";
  organizationId: string;
  actorId: string;
  metadata: {
    previousSettings?: OrganizationSettingsDTO | null;
    updatedSettings: OrganizationSettingsDTO;
  };
  timestamp: Date;
}

export type AuditHookHandler = (event: OrganizationSettingsUpdatedEvent) => Promise<void> | void;

export interface OrganizationDTO {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  createdAt: Date;
  metadata: string | null;
}

export interface OrganizationSettingsDTO {
  organizationId: string;
  defaultRetentionDays: number | null;
  downloadPermissions: string | null;
  exportPermissions: string | null;
  projectVisibility: string | null;
  updatedAt: Date;
  updatedBy: string | null;
}

export const updateOrganizationSettingsSchema = z.object({
  defaultRetentionDays: z
    .number()
    .int("Retention days must be an integer")
    .positive("Retention days must be a positive integer")
    .nullable()
    .optional(),
  downloadPermissions: z.string().nullable().optional(),
  exportPermissions: z.string().nullable().optional(),
  projectVisibility: z.string().nullable().optional(),
});

export type UpdateOrganizationSettingsInput = z.infer<typeof updateOrganizationSettingsSchema>;

export interface OrganizationServiceOptions {
  dbClient?: DbClient;
  auditService?: AuditService;
  auditHook?: AuditHookHandler;
}

/**
 * Organization Application Service (Phase 1 Identity & Tenancy)
 *
 * Responsibilities:
 * - Read current organization metadata (scoped strictly to TenantContext)
 * - Read organization settings (All roles: owner, admin, bioinformatician, scientist, viewer)
 * - Update organization settings (Owner or Admin only) with deterministic upsert
 *
 * INVARIANTS:
 * - Never derive organization identity from URL, query, or body.
 * - Every database query is strictly scoped by TenantContext.organizationId.
 * - updatedBy is derived exclusively from TenantContext.userId.
 * - Settings mutations and audit event persistence are executed atomically in the same transaction.
 */
export class OrganizationService {
  private readonly db: DbClient;
  private readonly auditService: AuditService;
  private readonly auditHook?: AuditHookHandler;

  constructor(options: OrganizationServiceOptions = {}) {
    this.db = options.dbClient ?? getDb();
    this.auditService = options.auditService ?? new AuditService({ dbClient: this.db });
    this.auditHook = options.auditHook;
  }

  /**
   * Retrieves organization metadata for the authenticated active tenant.
   * Cross-tenant IDOR protection: rejects if targetOrganizationId does not match TenantContext.
   */
  async getOrganization(
    context: TenantContext,
    targetOrganizationId: string
  ): Promise<OrganizationDTO> {
    validateTenantAccess(context, targetOrganizationId);

    const rows = await this.db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        logo: organization.logo,
        createdAt: organization.createdAt,
        metadata: organization.metadata,
      })
      .from(organization)
      .where(eq(organization.id, context.organizationId));

    const org = rows[0];
    if (!org) {
      throw new ResourceNotFoundError("Organization not found");
    }

    return org;
  }

  /**
   * Retrieves organization settings for the active tenant.
   * Readable by all canonical organization roles: owner, admin, bioinformatician, scientist, viewer.
   */
  async getSettings(
    context: TenantContext,
    targetOrganizationId: string
  ): Promise<OrganizationSettingsDTO | null> {
    validateTenantAccess(context, targetOrganizationId);

    const rows = await this.db
      .select({
        organizationId: organizationSettings.organizationId,
        defaultRetentionDays: organizationSettings.defaultRetentionDays,
        downloadPermissions: organizationSettings.downloadPermissions,
        exportPermissions: organizationSettings.exportPermissions,
        projectVisibility: organizationSettings.projectVisibility,
        updatedAt: organizationSettings.updatedAt,
        updatedBy: organizationSettings.updatedBy,
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, context.organizationId));

    return rows[0] ?? null;
  }

  /**
   * Updates organization settings with deterministic upsert.
   * Authorized strictly for Owner and Admin roles.
   * If row is missing, creates it. If existing, updates it.
   */
  async updateSettings(
    context: TenantContext,
    targetOrganizationId: string,
    rawInput: UpdateOrganizationSettingsInput
  ): Promise<OrganizationSettingsDTO> {
    validateTenantAccess(context, targetOrganizationId);
    assertOrgAdmin(context);

    // Validate input payload
    const parsed = updateOrganizationSettingsSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.message);
    }
    const input = parsed.data;

    return await this.db.transaction(async (tx) => {
      // Fetch existing settings if any
      const existingRows = await tx
        .select({
          organizationId: organizationSettings.organizationId,
          defaultRetentionDays: organizationSettings.defaultRetentionDays,
          downloadPermissions: organizationSettings.downloadPermissions,
          exportPermissions: organizationSettings.exportPermissions,
          projectVisibility: organizationSettings.projectVisibility,
          updatedAt: organizationSettings.updatedAt,
          updatedBy: organizationSettings.updatedBy,
        })
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, context.organizationId));

      const existing = existingRows[0] ?? null;
      const now = new Date();

      let updated: OrganizationSettingsDTO;

      if (!existing) {
        // Upsert: Create initial settings row
        const insertData = {
          organizationId: context.organizationId,
          defaultRetentionDays: input.defaultRetentionDays ?? null,
          downloadPermissions: input.downloadPermissions ?? null,
          exportPermissions: input.exportPermissions ?? null,
          projectVisibility: input.projectVisibility ?? null,
          updatedAt: now,
          updatedBy: context.userId,
        };

        await tx.insert(organizationSettings).values(insertData);
        updated = insertData;
      } else {
        // Upsert: Update existing settings row
        const updateData: {
          updatedAt: Date;
          updatedBy: string;
          defaultRetentionDays?: number | null;
          downloadPermissions?: string | null;
          exportPermissions?: string | null;
          projectVisibility?: string | null;
        } = {
          updatedAt: now,
          updatedBy: context.userId,
        };

        if (input.defaultRetentionDays !== undefined) {
          updateData.defaultRetentionDays = input.defaultRetentionDays;
        }
        if (input.downloadPermissions !== undefined) {
          updateData.downloadPermissions = input.downloadPermissions;
        }
        if (input.exportPermissions !== undefined) {
          updateData.exportPermissions = input.exportPermissions;
        }
        if (input.projectVisibility !== undefined) {
          updateData.projectVisibility = input.projectVisibility;
        }

        await tx
          .update(organizationSettings)
          .set(updateData)
          .where(eq(organizationSettings.organizationId, context.organizationId));

        updated = {
          organizationId: context.organizationId,
          defaultRetentionDays:
            input.defaultRetentionDays !== undefined
              ? input.defaultRetentionDays
              : existing.defaultRetentionDays,
          downloadPermissions:
            input.downloadPermissions !== undefined
              ? input.downloadPermissions
              : existing.downloadPermissions,
          exportPermissions:
            input.exportPermissions !== undefined
              ? input.exportPermissions
              : existing.exportPermissions,
          projectVisibility:
            input.projectVisibility !== undefined
              ? input.projectVisibility
              : existing.projectVisibility,
          updatedAt: now,
          updatedBy: context.userId,
        };
      }

      // Step H Transactional Audit Persistence:
      // Executed using the same transaction (tx) to ensure atomicity.
      await this.auditService.recordUserAuditEvent({
        db: tx,
        context,
        action: "org_settings.updated",
        resourceType: "organization_settings",
        resourceId: context.organizationId,
        metadata: {
          defaultRetentionDays: updated.defaultRetentionDays,
          downloadPermissions: updated.downloadPermissions,
          exportPermissions: updated.exportPermissions,
          projectVisibility: updated.projectVisibility,
        },
        timestamp: now,
      });

      if (this.auditHook) {
        await this.auditHook({
          eventType: "org_settings.updated",
          organizationId: context.organizationId,
          actorId: context.userId,
          metadata: {
            previousSettings: existing,
            updatedSettings: updated,
          },
          timestamp: now,
        });
      }

      return updated;
    });
  }
}

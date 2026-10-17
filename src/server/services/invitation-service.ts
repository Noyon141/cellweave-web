import { eq, and, gt } from "drizzle-orm";
import { z } from "zod";
import type { TenantContext, OrganizationRole } from "@/types";
import { ORGANIZATION_ROLES } from "@/types";
import { getDb, type DbClient } from "../database/client";
import { invitation } from "../database/schema/auth";
import { assertOrgAdmin } from "../authorization/guards";
import {
  ConflictError,
  ResourceNotFoundError,
  TenantAuthorizationError,
  ValidationError,
  validateTenantAccess,
} from "../authorization";
import { AuditService } from "./audit-service";
import { auth } from "../integrations/auth/better-auth";

/**
 * BetterAuth Organization API subset used for invitation lifecycle mutations.
 * Allows dependency injection for tests without bypassing official server API semantics.
 */
export interface BetterAuthInvitationResult {
  id: string;
  email: string;
  role: string;
  organizationId: string;
  inviterId: string;
  status: string;
  expiresAt: Date | string;
  createdAt?: Date | string;
}

export interface BetterAuthInvitationApi {
  createInvitation: (args: {
    body: {
      email: string;
      role: string | string[];
      organizationId?: string;
      resend?: boolean;
    };
    headers?: Headers;
  }) => Promise<BetterAuthInvitationResult>;
  cancelInvitation: (args: {
    body: {
      invitationId: string;
    };
    headers?: Headers;
  }) => Promise<unknown>;
}

/**
 * Audit Hook Point Event Definitions for Invitations (Step F)
 */
export interface UserInvitedEvent {
  eventType: "user.invited";
  organizationId: string;
  actorId: string;
  invitationId: string;
  email: string;
  role: OrganizationRole;
  expiresAt: Date;
  timestamp: Date;
}

export interface InvitationCanceledEvent {
  eventType: "invitation.canceled";
  organizationId: string;
  actorId: string;
  invitationId: string;
  email: string;
  timestamp: Date;
}

export type InvitationAuditHookHandler = (
  event: UserInvitedEvent | InvitationCanceledEvent
) => Promise<void> | void;

/**
 * Delivery boundary interface:
 * In Step F, invitations are recorded without sending real emails.
 * No external provider calls (e.g. Resend) are permitted in Step F.
 */
export interface InvitationDeliveryAdapter {
  recordInvitation(data: {
    invitationId: string;
    organizationId: string;
    email: string;
    role: OrganizationRole;
    expiresAt: Date;
  }): Promise<void> | void;
}

export const createInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email format"),
  role: z.string().min(1, "Role is required"),
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export interface InvitationDTO {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  status: "pending" | "accepted" | "rejected" | "canceled";
  expiresAt: Date;
  createdAt: Date;
  inviterId: string;
}

export interface InvitationServiceOptions {
  dbClient?: DbClient;
  auditService?: AuditService;
  auditHook?: InvitationAuditHookHandler;
  deliveryAdapter?: InvitationDeliveryAdapter;
  authApi?: BetterAuthInvitationApi;
  /**
   * Default invitation expiration lifetime in milliseconds.
   * Default: 7 days.
   */
  expirationMs?: number;
}

/**
 * Invitation Application Service (Phase 1 Identity & Tenancy)
 *
 * Responsibilities:
 * - Create invitations (Owner or Admin only)
 * - Prevent active pending duplicate invitations for the same normalized email
 * - Enforce canonical roles (owner invitation is rejected in Phase 1)
 * - Cancel pending invitations (Owner or Admin only)
 * - List invitations (Scoped to TenantContext)
 *
 * INVARIANTS:
 * - Admin cannot invite someone as Owner.
 * - Owner invitation is rejected in Phase 1 (no improvised ownership-transfer).
 * - Queries are strictly scoped to TenantContext.organizationId.
 * - Delivery boundary does not make external network or email provider calls.
 * - Lifecycle mutations (Category B) MUST delegate to official BetterAuth server APIs (auth.api.*).
 * - Direct Drizzle inserts/updates against the BetterAuth invitation table are strictly forbidden.
 * - Atomicity note: BetterAuth manages its own internal adapter calls and does not share external
 *   PostgreSQL transactions. Therefore, CellWeave pre-validates all tenant authorization rules,
 *   delegates mutation to BetterAuth official API, and immediately persists the audit event afterwards.
 *   If audit persistence fails, the error is surfaced explicitly.
 */
export class InvitationService {
  private readonly db: DbClient;
  private readonly auditService: AuditService;
  private readonly auditHook?: InvitationAuditHookHandler;
  private readonly deliveryAdapter?: InvitationDeliveryAdapter;
  private readonly authApi: BetterAuthInvitationApi;
  private readonly expirationMs: number;

  constructor(options: InvitationServiceOptions = {}) {
    this.db = options.dbClient ?? getDb();
    this.auditService = options.auditService ?? new AuditService({ dbClient: this.db });
    this.auditHook = options.auditHook;
    this.deliveryAdapter = options.deliveryAdapter;
    this.authApi = options.authApi ?? (auth.api as unknown as BetterAuthInvitationApi);
    this.expirationMs = options.expirationMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
  }

  /**
   * Lists invitations for the tenant organization.
   * Scoped strictly to TenantContext.organizationId.
   */
  async listInvitations(
    context: TenantContext,
    targetOrganizationId: string
  ): Promise<InvitationDTO[]> {
    validateTenantAccess(context, targetOrganizationId);
    assertOrgAdmin(context);

    const rows = await this.db
      .select({
        id: invitation.id,
        organizationId: invitation.organizationId,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
        inviterId: invitation.inviterId,
      })
      .from(invitation)
      .where(eq(invitation.organizationId, context.organizationId));

    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      email: r.email,
      role: r.role as OrganizationRole,
      status: r.status as "pending" | "accepted" | "rejected" | "canceled",
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      inviterId: r.inviterId,
    }));
  }

  /**
   * Creates an invitation for an email address to join the organization.
   *
   * Security Invariants:
   * 1. Only Owner and Admin can invite.
   * 2. Canonical roles only.
   * 3. Admin cannot invite Owner.
   * 4. Owner invitation is rejected (cannot use invitations as improvised ownership transfer).
   * 5. Active duplicate prevention:
   *    If an invitation with status = 'pending' and expiresAt > now exists for normalized email,
   *    throws ConflictError.
   *    Historical records ('accepted', 'rejected', 'canceled', expired) do NOT block reinvitation.
   * 6. Delivery boundary: no real email sent.
   */
  async createInvitation(
    context: TenantContext,
    targetOrganizationId: string,
    rawInput: CreateInvitationInput,
    options?: {
      headers?: Headers;
      requestMetadata?: { clientIp?: string | null; userAgent?: string | null };
    }
  ): Promise<InvitationDTO> {
    validateTenantAccess(context, targetOrganizationId);
    assertOrgAdmin(context);

    const parsed = createInvitationSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.message);
    }

    const { email: rawEmail, role: rawRole } = parsed.data;
    const normalizedEmail = rawEmail.trim().toLowerCase();

    // Validate canonical role
    if (!ORGANIZATION_ROLES.includes(rawRole as OrganizationRole)) {
      throw new ValidationError(
        `Invalid role '${rawRole}'. Must be one of: ${ORGANIZATION_ROLES.join(", ")}`
      );
    }
    const role = rawRole as OrganizationRole;

    // Safety Guard 1: Admin cannot invite Owner
    if (context.role === "admin" && role === "owner") {
      throw new TenantAuthorizationError("Admins cannot invite an owner");
    }

    // Safety Guard 2: Owner invitation is rejected in Phase 1
    if (role === "owner") {
      throw new TenantAuthorizationError("Owner invitations are not permitted in Phase 1");
    }

    const now = new Date();

    // Active duplicate check:
    // Look for existing pending invitation in this org where expiresAt > now
    const activeInvitations = await this.db
      .select({
        id: invitation.id,
        email: invitation.email,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
      })
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, context.organizationId),
          eq(invitation.email, normalizedEmail),
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, now)
        )
      );

    if (activeInvitations.length > 0) {
      throw new ConflictError(`An active invitation already exists for '${normalizedEmail}'`);
    }

    // Category B Mutation: Delegate to BetterAuth official server API
    const createdInvitation = await this.authApi.createInvitation({
      body: {
        email: normalizedEmail,
        role,
        organizationId: context.organizationId,
      },
      headers: options?.headers,
    });

    const expiresAt =
      createdInvitation.expiresAt instanceof Date
        ? createdInvitation.expiresAt
        : new Date(createdInvitation.expiresAt);

    // Persist audit event after successful BetterAuth mutation
    await this.auditService.recordUserAuditEvent({
      context,
      action: "user.invited",
      resourceType: "invitation",
      resourceId: createdInvitation.id,
      metadata: {
        role,
        expiresAt: expiresAt.toISOString(),
      },
      clientIp: options?.requestMetadata?.clientIp,
      userAgent: options?.requestMetadata?.userAgent,
      timestamp: now,
    });

    // Call delivery boundary (recording/no-op; never sends real external email)
    if (this.deliveryAdapter) {
      await this.deliveryAdapter.recordInvitation({
        invitationId: createdInvitation.id,
        organizationId: context.organizationId,
        email: normalizedEmail,
        role,
        expiresAt,
      });
    }

    if (this.auditHook) {
      await this.auditHook({
        eventType: "user.invited",
        organizationId: context.organizationId,
        actorId: context.userId,
        invitationId: createdInvitation.id,
        email: normalizedEmail,
        role,
        expiresAt,
        timestamp: now,
      });
    }

    return {
      id: createdInvitation.id,
      organizationId: context.organizationId,
      email: normalizedEmail,
      role,
      status: "pending",
      expiresAt,
      createdAt: now,
      inviterId: context.userId,
    };
  }

  /**
   * Cancels a pending invitation.
   * Scoped strictly by invitationId AND TenantContext.organizationId.
   */
  async cancelInvitation(
    context: TenantContext,
    targetOrganizationId: string,
    targetInvitationId: string,
    options?: {
      headers?: Headers;
      requestMetadata?: { clientIp?: string | null; userAgent?: string | null };
    }
  ): Promise<void> {
    validateTenantAccess(context, targetOrganizationId);
    assertOrgAdmin(context);

    const rows = await this.db
      .select({
        id: invitation.id,
        organizationId: invitation.organizationId,
        email: invitation.email,
        status: invitation.status,
      })
      .from(invitation)
      .where(
        and(
          eq(invitation.id, targetInvitationId),
          eq(invitation.organizationId, context.organizationId)
        )
      );

    const target = rows[0];
    if (!target) {
      throw new ResourceNotFoundError("Invitation not found in organization");
    }

    if (target.status !== "pending") {
      throw new ConflictError(`Cannot cancel invitation in '${target.status}' status`);
    }

    // Category B Mutation: Delegate to BetterAuth official server API
    await this.authApi.cancelInvitation({
      body: {
        invitationId: targetInvitationId,
      },
      headers: options?.headers,
    });

    const now = new Date();

    // Persist audit event after successful BetterAuth mutation
    await this.auditService.recordUserAuditEvent({
      context,
      action: "invitation.canceled",
      resourceType: "invitation",
      resourceId: target.id,
      metadata: {},
      clientIp: options?.requestMetadata?.clientIp,
      userAgent: options?.requestMetadata?.userAgent,
      timestamp: now,
    });

    if (this.auditHook) {
      await this.auditHook({
        eventType: "invitation.canceled",
        organizationId: context.organizationId,
        actorId: context.userId,
        invitationId: target.id,
        email: target.email,
        timestamp: now,
      });
    }
  }
}

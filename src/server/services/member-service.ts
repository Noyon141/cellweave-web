import { eq, and } from "drizzle-orm";
import type { TenantContext, OrganizationRole } from "@/types";
import { ORGANIZATION_ROLES } from "@/types";
import { getDb, type DbClient } from "../database/client";
import { member, user } from "../database/schema/auth";
import { assertOrgAdmin } from "../authorization/guards";
import {
  ResourceNotFoundError,
  TenantAuthorizationError,
  ValidationError,
  validateTenantAccess,
} from "../authorization";
import { AuditService } from "./audit-service";

/**
 * Audit Hook Point Event Definitions for Membership Actions (Step F)
 */
export interface MemberRoleChangedEvent {
  eventType: "member.role.changed";
  organizationId: string;
  actorId: string;
  targetMemberId: string;
  targetUserId: string;
  oldRole: OrganizationRole;
  newRole: OrganizationRole;
  timestamp: Date;
}

export interface MemberRemovedEvent {
  eventType: "member.removed";
  organizationId: string;
  actorId: string;
  targetMemberId: string;
  targetUserId: string;
  role: OrganizationRole;
  timestamp: Date;
}

export type MemberAuditHookHandler = (
  event: MemberRoleChangedEvent | MemberRemovedEvent
) => Promise<void> | void;

export interface MemberDTO {
  id: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  createdAt: Date;
  user: {
    name: string;
    email: string;
    image?: string | null;
  };
}

export interface MemberServiceOptions {
  dbClient?: DbClient;
  auditService?: AuditService;
  auditHook?: MemberAuditHookHandler;
}

/**
 * Member Application Service (Phase 1 Identity & Tenancy)
 *
 * Responsibilities:
 * - List active organization members (Scoped to TenantContext)
 * - Update another member's canonical role (Owner or Admin)
 * - Remove membership where permitted (Owner or Admin)
 *
 * INVARIANTS:
 * - Admin cannot assign owner role.
 * - Admin cannot modify or remove an owner.
 * - Non-admin roles (bioinformatician, scientist, viewer) cannot mutate membership.
 * - Ownership transfer / owner self-removal is rejected in Phase 1 (no ownerless orgs).
 * - Queries are strictly scoped to TenantContext.organizationId.
 * - Role updates and member removals execute atomically with audit persistence in a single transaction.
 */
export class MemberService {
  private readonly db: DbClient;
  private readonly auditService: AuditService;
  private readonly auditHook?: MemberAuditHookHandler;

  constructor(options: MemberServiceOptions = {}) {
    this.db = options.dbClient ?? getDb();
    this.auditService = options.auditService ?? new AuditService({ dbClient: this.db });
    this.auditHook = options.auditHook;
  }

  /**
   * Lists active members of the tenant organization.
   * Accessible by all members of the organization.
   */
  async listMembers(context: TenantContext, targetOrganizationId: string): Promise<MemberDTO[]> {
    validateTenantAccess(context, targetOrganizationId);

    const rows = await this.db
      .select({
        id: member.id,
        organizationId: member.organizationId,
        userId: member.userId,
        role: member.role,
        createdAt: member.createdAt,
        userName: user.name,
        userEmail: user.email,
        userImage: user.image,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, context.organizationId));

    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      userId: r.userId,
      role: r.role as OrganizationRole,
      createdAt: r.createdAt,
      user: {
        name: r.userName,
        email: r.userEmail,
        image: r.userImage,
      },
    }));
  }

  /**
   * Updates an existing member's organization role.
   * Strict authorization boundaries:
   * - Only Owner or Admin can update roles.
   * - Admin cannot promote anyone to Owner.
   * - Admin cannot modify an Owner's role.
   * - Roles must belong to canonical ORGANIZATION_ROLES.
   * - Ownership transfer is not supported in Phase 1 (fails closed).
   */
  async updateMemberRole(
    context: TenantContext,
    targetOrganizationId: string,
    targetMemberId: string,
    newRole: string
  ): Promise<MemberDTO> {
    validateTenantAccess(context, targetOrganizationId);
    assertOrgAdmin(context);

    // Validate canonical role
    if (!ORGANIZATION_ROLES.includes(newRole as OrganizationRole)) {
      throw new ValidationError(
        `Invalid role '${newRole}'. Must be one of: ${ORGANIZATION_ROLES.join(", ")}`
      );
    }
    const targetRole = newRole as OrganizationRole;

    return await this.db.transaction(async (tx) => {
      // Retrieve target member strictly scoped by organizationId
      const rows = await tx
        .select({
          id: member.id,
          organizationId: member.organizationId,
          userId: member.userId,
          role: member.role,
          createdAt: member.createdAt,
          userName: user.name,
          userEmail: user.email,
          userImage: user.image,
        })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(
          and(eq(member.id, targetMemberId), eq(member.organizationId, context.organizationId))
        );

      const targetMember = rows[0];
      if (!targetMember) {
        throw new ResourceNotFoundError("Member not found in organization");
      }

      const currentTargetRole = targetMember.role as OrganizationRole;

      // Safety Guard 1: Admin cannot promote anyone to Owner
      if (context.role === "admin" && targetRole === "owner") {
        throw new TenantAuthorizationError("Admins cannot assign the owner role");
      }

      // Safety Guard 2: Admin cannot modify an Owner
      if (context.role === "admin" && currentTargetRole === "owner") {
        throw new TenantAuthorizationError("Admins cannot modify an owner's role");
      }

      // Safety Guard 3: Ownership transfer semantics are not defined for Phase 1
      // If target is owner and role is changed, or target is made owner, reject fail-closed
      if (currentTargetRole === "owner" && targetRole !== "owner") {
        throw new TenantAuthorizationError(
          "Owner demotion or ownership transfer is not supported in Phase 1"
        );
      }
      if (currentTargetRole !== "owner" && targetRole === "owner") {
        throw new TenantAuthorizationError(
          "Ownership assignment is not supported via member role update in Phase 1"
        );
      }

      // Apply update using tx
      await tx
        .update(member)
        .set({ role: targetRole })
        .where(
          and(eq(member.id, targetMemberId), eq(member.organizationId, context.organizationId))
        );

      const now = new Date();

      // Step H Transactional Audit Persistence:
      // Executed using the same transaction (tx) to ensure atomicity.
      await this.auditService.recordUserAuditEvent({
        db: tx,
        context,
        action: "member.role_changed",
        resourceType: "member",
        resourceId: targetMember.id,
        metadata: {
          targetUserId: targetMember.userId,
          previousRole: currentTargetRole,
          newRole: targetRole,
        },
        timestamp: now,
      });

      if (this.auditHook) {
        await this.auditHook({
          eventType: "member.role.changed",
          organizationId: context.organizationId,
          actorId: context.userId,
          targetMemberId: targetMember.id,
          targetUserId: targetMember.userId,
          oldRole: currentTargetRole,
          newRole: targetRole,
          timestamp: now,
        });
      }

      return {
        id: targetMember.id,
        organizationId: targetMember.organizationId,
        userId: targetMember.userId,
        role: targetRole,
        createdAt: targetMember.createdAt,
        user: {
          name: targetMember.userName,
          email: targetMember.userEmail,
          image: targetMember.userImage,
        },
      };
    });
  }

  /**
   * Removes a member from the organization.
   * Strict authorization boundaries:
   * - Only Owner or Admin can remove members.
   * - Admin cannot remove an Owner.
   * - An Owner cannot be removed (prevents ownerless organizations).
   */
  async removeMember(
    context: TenantContext,
    targetOrganizationId: string,
    targetMemberId: string
  ): Promise<void> {
    validateTenantAccess(context, targetOrganizationId);
    assertOrgAdmin(context);

    return await this.db.transaction(async (tx) => {
      // Retrieve target member strictly scoped by organizationId
      const rows = await tx
        .select({
          id: member.id,
          organizationId: member.organizationId,
          userId: member.userId,
          role: member.role,
        })
        .from(member)
        .where(
          and(eq(member.id, targetMemberId), eq(member.organizationId, context.organizationId))
        );

      const target = rows[0];
      if (!target) {
        throw new ResourceNotFoundError("Member not found in organization");
      }

      const targetRole = target.role as OrganizationRole;

      // Safety Guard 1: Admin cannot remove an Owner
      if (context.role === "admin" && targetRole === "owner") {
        throw new TenantAuthorizationError("Admins cannot remove an owner");
      }

      // Safety Guard 2: An organization cannot be left ownerless
      if (targetRole === "owner") {
        throw new TenantAuthorizationError(
          "Owners cannot be removed from an organization in Phase 1"
        );
      }

      // Delete membership using tx
      await tx
        .delete(member)
        .where(
          and(eq(member.id, targetMemberId), eq(member.organizationId, context.organizationId))
        );

      const now = new Date();

      // Step H Transactional Audit Persistence:
      // Executed using the same transaction (tx) to ensure atomicity.
      await this.auditService.recordUserAuditEvent({
        db: tx,
        context,
        action: "member.removed",
        resourceType: "member",
        resourceId: target.id,
        metadata: {
          targetUserId: target.userId,
          role: targetRole,
        },
        timestamp: now,
      });

      if (this.auditHook) {
        await this.auditHook({
          eventType: "member.removed",
          organizationId: context.organizationId,
          actorId: context.userId,
          targetMemberId: target.id,
          targetUserId: target.userId,
          role: targetRole,
          timestamp: now,
        });
      }
    });
  }
}

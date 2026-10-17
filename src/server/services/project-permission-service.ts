import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { TenantContext, OrganizationRole } from "@/types";
import { getDb, type DbClient } from "../database/client";
import { projects, projectMembers } from "../database/schema/projects";
import { member, user } from "../database/schema/auth";
import { assertOrgAdmin } from "../authorization/guards";
import {
  ConflictError,
  ResourceNotFoundError,
  TenantAuthorizationError,
  ValidationError,
} from "../authorization";

/**
 * Step H Audit Hook Point Event Definitions for Project Member Actions
 */
export interface ProjectMemberAssignedEvent {
  eventType: "project_member.assigned";
  organizationId: string;
  actorId: string;
  projectId: string;
  targetUserId: string;
  projectMemberId: string;
  timestamp: Date;
}

export interface ProjectMemberRemovedEvent {
  eventType: "project_member.removed";
  organizationId: string;
  actorId: string;
  projectId: string;
  targetUserId: string;
  timestamp: Date;
}

export type ProjectAuditHookHandler = (
  event: ProjectMemberAssignedEvent | ProjectMemberRemovedEvent
) => Promise<void> | void;

export interface ProjectAccessResult {
  hasAccess: true;
  projectId: string;
  organizationId: string;
  role: OrganizationRole;
  accessType: "organization_wide" | "project_assignment";
}

export interface ProjectMemberDTO {
  id: string;
  projectId: string;
  organizationId: string;
  userId: string;
  role: OrganizationRole;
  assignedAt: Date;
  user: {
    name: string;
    email: string;
    image?: string | null;
  };
}

export interface ProjectPermissionServiceOptions {
  dbClient?: DbClient;
  auditHook?: ProjectAuditHookHandler;
}

/**
 * Project Permission & Access Service (Phase 1 Identity & Tenancy)
 *
 * Core Master Design Invariant:
 * - Organization role defines baseline capability.
 * - Project membership determines access to specific projects for lower roles.
 * - Project membership is assignment/access only (NO project-level role).
 *
 * Role Access Policies:
 * - OWNER: Organization-wide access to all projects in active tenant (no assignment required).
 * - ADMIN: Organization-wide access/oversight to all projects in active tenant (no assignment required).
 * - BIOINFORMATICIAN: Requires explicit project_members assignment row.
 * - SCIENTIST: Requires explicit project_members assignment row.
 * - VIEWER: Requires explicit project_members assignment row.
 *
 * Safety Invariants:
 * - Never query projects or project_members without organizationId = context.organizationId.
 * - Non-existent projects and foreign-tenant projects are non-disclosing (ResourceNotFoundError).
 * - Redundant assignments for Owner/Admin are rejected (they have org-wide access by role).
 * - Target users must have a current active membership in context.organizationId.
 */
export class ProjectPermissionService {
  private readonly db: DbClient;
  private readonly auditHook?: ProjectAuditHookHandler;

  constructor(options: ProjectPermissionServiceOptions = {}) {
    this.db = options.dbClient ?? getDb();
    this.auditHook = options.auditHook;
  }

  /**
   * Asserts that the authenticated actor has access to the specified project.
   * Reusable authorization boundary for future Phase 2 services.
   *
   * Flow:
   * 1. Resolves project strictly inside context.organizationId.
   * 2. If missing or belongs to another tenant, throws ResourceNotFoundError (non-disclosing).
   * 3. If context.role is 'owner' or 'admin', access is granted organization-wide.
   * 4. If 'bioinformatician', 'scientist', or 'viewer', queries project_members for explicit assignment.
   * 5. If assignment missing, throws TenantAuthorizationError without leaking project internals.
   */
  async assertProjectAccess(
    context: TenantContext,
    projectId: string
  ): Promise<ProjectAccessResult> {
    // 1. Tenant-scoped project resolution
    const projectRows = await this.db
      .select({
        id: projects.id,
        organizationId: projects.organizationId,
      })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, context.organizationId)));

    const projectRecord = projectRows[0];
    if (!projectRecord) {
      // Non-disclosing: identical error whether project does not exist or belongs to another org
      throw new ResourceNotFoundError("Project not found");
    }

    // 2. Role-based baseline access
    if (context.role === "owner" || context.role === "admin") {
      return {
        hasAccess: true,
        projectId: projectRecord.id,
        organizationId: projectRecord.organizationId,
        role: context.role,
        accessType: "organization_wide",
      };
    }

    // 3. Lower roles require explicit project_members assignment
    const assignmentRows = await this.db
      .select({
        id: projectMembers.id,
      })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.organizationId, context.organizationId),
          eq(projectMembers.userId, context.userId)
        )
      );

    if (assignmentRows.length === 0) {
      throw new TenantAuthorizationError("Access denied: user is not assigned to this project");
    }

    return {
      hasAccess: true,
      projectId: projectRecord.id,
      organizationId: projectRecord.organizationId,
      role: context.role,
      accessType: "project_assignment",
    };
  }

  /**
   * Assigns an organization member to a project.
   *
   * Authorization:
   * - Only Owner or Admin can assign members.
   *
   * Invariants:
   * 1. Project must belong to context.organizationId.
   * 2. Target user must have a current active membership in context.organizationId.
   * 3. If target user has role 'owner' or 'admin', rejects with ValidationError (redundant assignment).
   * 4. Duplicate assignment prevention: throws ConflictError if user is already assigned.
   * 5. Auditing: Triggers Step H audit hook point.
   */
  async assignMemberToProject(
    context: TenantContext,
    projectId: string,
    targetUserId: string
  ): Promise<ProjectMemberDTO> {
    assertOrgAdmin(context);

    // 1. Verify project exists within tenant
    const projectRows = await this.db
      .select({
        id: projects.id,
        organizationId: projects.organizationId,
      })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, context.organizationId)));

    const projectRecord = projectRows[0];
    if (!projectRecord) {
      throw new ResourceNotFoundError("Project not found");
    }

    // 2. Verify target user has active membership in the active organization
    const memberRows = await this.db
      .select({
        id: member.id,
        userId: member.userId,
        role: member.role,
        userName: user.name,
        userEmail: user.email,
        userImage: user.image,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(
        and(eq(member.organizationId, context.organizationId), eq(member.userId, targetUserId))
      );

    const targetMember = memberRows[0];
    if (!targetMember) {
      // User is not a member of this tenant
      throw new ResourceNotFoundError("Target user is not a member of this organization");
    }

    const targetOrgRole = targetMember.role as OrganizationRole;

    // 3. Invariant: Owner/Admin already possess organization-wide access
    if (targetOrgRole === "owner" || targetOrgRole === "admin") {
      throw new ValidationError(
        `Users with organization role '${targetOrgRole}' have organization-wide project access by role and cannot be assigned to individual projects`
      );
    }

    // 4. Duplicate assignment check
    const existingAssignment = await this.db
      .select({
        id: projectMembers.id,
      })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.organizationId, context.organizationId),
          eq(projectMembers.userId, targetUserId)
        )
      );

    if (existingAssignment.length > 0) {
      throw new ConflictError("User is already assigned to this project");
    }

    // 5. Insert assignment
    const assignmentId = `pm_${randomUUID()}`;
    const now = new Date();

    await this.db.insert(projectMembers).values({
      id: assignmentId,
      organizationId: context.organizationId,
      projectId,
      userId: targetUserId,
      createdAt: now,
    });

    // Step H Audit Hook Point
    if (this.auditHook) {
      await this.auditHook({
        eventType: "project_member.assigned",
        organizationId: context.organizationId,
        actorId: context.userId,
        projectId,
        targetUserId,
        projectMemberId: assignmentId,
        timestamp: now,
      });
    }

    return {
      id: assignmentId,
      projectId,
      organizationId: context.organizationId,
      userId: targetUserId,
      role: targetOrgRole,
      assignedAt: now,
      user: {
        name: targetMember.userName,
        email: targetMember.userEmail,
        image: targetMember.userImage,
      },
    };
  }

  /**
   * Removes a member's assignment from a project.
   *
   * Authorization:
   * - Only Owner or Admin can remove members.
   *
   * Invariants:
   * 1. Project must belong to context.organizationId.
   * 2. Assignment must exist for projectId + targetUserId + context.organizationId.
   * 3. Non-disclosing if project or assignment is missing.
   * 4. Does not affect or mutate the user's organization membership.
   */
  async removeMemberFromProject(
    context: TenantContext,
    projectId: string,
    targetUserId: string
  ): Promise<void> {
    assertOrgAdmin(context);

    // 1. Verify project exists within tenant
    const projectRows = await this.db
      .select({
        id: projects.id,
      })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, context.organizationId)));

    if (!projectRows[0]) {
      throw new ResourceNotFoundError("Project not found");
    }

    // 2. Find target assignment
    const assignmentRows = await this.db
      .select({
        id: projectMembers.id,
      })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.organizationId, context.organizationId),
          eq(projectMembers.userId, targetUserId)
        )
      );

    const assignment = assignmentRows[0];
    if (!assignment) {
      throw new ResourceNotFoundError("Project member assignment not found");
    }

    // 3. Delete assignment
    await this.db
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.id, assignment.id),
          eq(projectMembers.organizationId, context.organizationId)
        )
      );

    const now = new Date();

    // Step H Audit Hook Point
    if (this.auditHook) {
      await this.auditHook({
        eventType: "project_member.removed",
        organizationId: context.organizationId,
        actorId: context.userId,
        projectId,
        targetUserId,
        timestamp: now,
      });
    }
  }

  /**
   * Lists all members assigned to a project.
   *
   * Authorization:
   * - Owner and Admin may list project assignments.
   * - Lower roles (Bioinformatician, Scientist, Viewer) may list project assignments
   *   only if they are themselves assigned to the project.
   */
  async listProjectMembers(context: TenantContext, projectId: string): Promise<ProjectMemberDTO[]> {
    // Check access first (enforces tenant scope and assignment check)
    await this.assertProjectAccess(context, projectId);

    const rows = await this.db
      .select({
        id: projectMembers.id,
        projectId: projectMembers.projectId,
        organizationId: projectMembers.organizationId,
        userId: projectMembers.userId,
        assignedAt: projectMembers.createdAt,
        orgRole: member.role,
        userName: user.name,
        userEmail: user.email,
        userImage: user.image,
      })
      .from(projectMembers)
      .innerJoin(
        member,
        and(
          eq(projectMembers.userId, member.userId),
          eq(projectMembers.organizationId, member.organizationId)
        )
      )
      .innerJoin(user, eq(projectMembers.userId, user.id))
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.organizationId, context.organizationId)
        )
      );

    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      organizationId: r.organizationId,
      userId: r.userId,
      role: r.orgRole as OrganizationRole,
      assignedAt: r.assignedAt,
      user: {
        name: r.userName,
        email: r.userEmail,
        image: r.userImage,
      },
    }));
  }
}

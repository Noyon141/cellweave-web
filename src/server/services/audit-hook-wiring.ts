import type { AuditService } from "./audit-service";
import type { AuditHookHandler as OrgAuditHookHandler } from "./organization-service";
import type { MemberAuditHookHandler } from "./member-service";
import type { InvitationAuditHookHandler } from "./invitation-service";
import type { ProjectAuditHookHandler } from "./project-permission-service";

/**
 * Creates an AuditHookHandler for OrganizationService that persists events via AuditService.
 */
export function createOrganizationAuditHook(auditService: AuditService): OrgAuditHookHandler {
  return async (event) => {
    await auditService.recordAuditEvent({
      explicitScope: {
        organizationId: event.organizationId,
        actorType: "user",
        actorId: event.actorId,
      },
      action: event.eventType,
      resourceType: "organization_settings",
      resourceId: event.organizationId,
      metadata: {
        defaultRetentionDays: event.metadata.updatedSettings.defaultRetentionDays,
        downloadPermissions: event.metadata.updatedSettings.downloadPermissions,
        exportPermissions: event.metadata.updatedSettings.exportPermissions,
        projectVisibility: event.metadata.updatedSettings.projectVisibility,
      },
      timestamp: event.timestamp,
    });
  };
}

/**
 * Creates a MemberAuditHookHandler for MemberService that persists events via AuditService.
 */
export function createMemberAuditHook(auditService: AuditService): MemberAuditHookHandler {
  return async (event) => {
    if (event.eventType === "member.role.changed") {
      await auditService.recordAuditEvent({
        explicitScope: {
          organizationId: event.organizationId,
          actorType: "user",
          actorId: event.actorId,
        },
        action: "member.role_changed",
        resourceType: "member",
        resourceId: event.targetMemberId,
        metadata: {
          targetUserId: event.targetUserId,
          previousRole: event.oldRole,
          newRole: event.newRole,
        },
        timestamp: event.timestamp,
      });
    } else if (event.eventType === "member.removed") {
      await auditService.recordAuditEvent({
        explicitScope: {
          organizationId: event.organizationId,
          actorType: "user",
          actorId: event.actorId,
        },
        action: "member.removed",
        resourceType: "member",
        resourceId: event.targetMemberId,
        metadata: {
          targetUserId: event.targetUserId,
          role: event.role,
        },
        timestamp: event.timestamp,
      });
    }
  };
}

/**
 * Creates an InvitationAuditHookHandler for InvitationService that persists events via AuditService.
 */
export function createInvitationAuditHook(auditService: AuditService): InvitationAuditHookHandler {
  return async (event) => {
    if (event.eventType === "user.invited") {
      await auditService.recordAuditEvent({
        explicitScope: {
          organizationId: event.organizationId,
          actorType: "user",
          actorId: event.actorId,
        },
        action: "user.invited",
        resourceType: "invitation",
        resourceId: event.invitationId,
        metadata: {
          role: event.role,
          expiresAt: event.expiresAt.toISOString(),
        },
        timestamp: event.timestamp,
      });
    } else if (event.eventType === "invitation.canceled") {
      await auditService.recordAuditEvent({
        explicitScope: {
          organizationId: event.organizationId,
          actorType: "user",
          actorId: event.actorId,
        },
        action: "invitation.canceled",
        resourceType: "invitation",
        resourceId: event.invitationId,
        metadata: {},
        timestamp: event.timestamp,
      });
    }
  };
}

/**
 * Creates a ProjectAuditHookHandler for ProjectPermissionService that persists events via AuditService.
 */
export function createProjectAuditHook(auditService: AuditService): ProjectAuditHookHandler {
  return async (event) => {
    if (event.eventType === "project_member.assigned") {
      await auditService.recordAuditEvent({
        explicitScope: {
          organizationId: event.organizationId,
          actorType: "user",
          actorId: event.actorId,
        },
        action: "project_member.assigned",
        resourceType: "project_member",
        resourceId: event.projectMemberId,
        metadata: {
          projectId: event.projectId,
          targetUserId: event.targetUserId,
        },
        timestamp: event.timestamp,
      });
    } else if (event.eventType === "project_member.removed") {
      await auditService.recordAuditEvent({
        explicitScope: {
          organizationId: event.organizationId,
          actorType: "user",
          actorId: event.actorId,
        },
        action: "project_member.removed",
        resourceType: "project_member",
        resourceId: `${event.projectId}:${event.targetUserId}`,
        metadata: {
          projectId: event.projectId,
          targetUserId: event.targetUserId,
        },
        timestamp: event.timestamp,
      });
    }
  };
}

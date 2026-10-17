import { createAccessControl } from "better-auth/plugins/access";
import type { OrganizationRole } from "@cellweave/contracts";

/**
 * Phase 1 BetterAuth Access Control Statement
 * Strictly limited to identity, tenancy, organization settings, and project access boundaries.
 * Scientific pipeline, export, analysis, and billing execution permissions are strictly excluded in Phase 1.
 */
export const statement = {
  organization: ["update", "delete"],
  settings: ["read", "update"],
  member: ["create", "read", "update", "delete"],
  invitation: ["create", "read", "cancel"],
  auditLog: ["read"],
  projectAccess: ["read", "assign"],
} as const;

export type Statement = typeof statement;

export const ac = createAccessControl(statement);

/**
 * OWNER: Full organization governance, settings, member administration,
 * project access oversight, audit log inspection, and organization deletion/ownership transfer.
 */
export const owner = ac.newRole({
  organization: ["update", "delete"],
  settings: ["read", "update"],
  member: ["create", "read", "update", "delete"],
  invitation: ["create", "read", "cancel"],
  auditLog: ["read"],
  projectAccess: ["read", "assign"],
});

/**
 * ADMIN: Member invitations/management, project access assignment, and organization settings.
 * Strictly prohibited: organization deletion, ownership transfer, and audit-log read.
 */
export const admin = ac.newRole({
  organization: ["update"],
  settings: ["read", "update"],
  member: ["create", "read", "update", "delete"],
  invitation: ["create", "read", "cancel"],
  auditLog: [],
  projectAccess: ["read", "assign"],
});

/**
 * BIOINFORMATICIAN: Scientific practitioner.
 * Baseline organization access is read-only for member lists and settings.
 * No organization or membership administration. Project execution is gated by project assignment.
 */
export const bioinformatician = ac.newRole({
  organization: [],
  settings: ["read"],
  member: ["read"],
  invitation: [],
  auditLog: [],
  projectAccess: ["read"],
});

/**
 * SCIENTIST: Scientific collaborator.
 * Read-only organization context for member lists and settings.
 * No organization or membership administration. Project visibility is gated by project assignment.
 */
export const scientist = ac.newRole({
  organization: [],
  settings: ["read"],
  member: ["read"],
  invitation: [],
  auditLog: [],
  projectAccess: ["read"],
});

/**
 * VIEWER: Read-only organization context required for assigned project visibility.
 * Strictly no administrative, mutation, or invitation permissions.
 */
export const viewer = ac.newRole({
  organization: [],
  settings: ["read"],
  member: ["read"],
  invitation: [],
  auditLog: [],
  projectAccess: ["read"],
});

/**
 * Canonical five-role mapping conforming strictly to the CellWeave master design.
 * Exhaustiveness is enforced via Record<OrganizationRole, unknown>.
 */
export const roles = {
  owner,
  admin,
  bioinformatician,
  scientist,
  viewer,
} satisfies Record<OrganizationRole, unknown>;

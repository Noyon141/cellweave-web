import { ORGANIZATION_ROLES, type OrganizationRole } from "@/types";
import { TenantAuthorizationError } from "./errors";
import type { TenantContext } from "./tenant-context";

/**
 * Asserts that the actor possesses one of the specified allowed organization roles.
 * Throws TenantAuthorizationError if role is not satisfied.
 */
export function assertRole(
  context: TenantContext | null | undefined,
  allowedRoles: readonly OrganizationRole[]
): asserts context is TenantContext {
  if (!context || !context.role) {
    throw new TenantAuthorizationError(
      "Tenant authorization context is missing or unauthenticated"
    );
  }

  // Defensively ensure role is a valid canonical OrganizationRole
  if (!ORGANIZATION_ROLES.includes(context.role)) {
    throw new TenantAuthorizationError(
      `Unknown or invalid organization role: ${String(context.role)}`
    );
  }

  if (!allowedRoles.includes(context.role)) {
    throw new TenantAuthorizationError(
      `Access denied: required role in [${allowedRoles.join(", ")}], current role is '${context.role}'`
    );
  }
}

/**
 * Asserts that the actor is the organization owner.
 * Owner-only operations: deletion, ownership transfer, audit log inspection.
 */
export function assertOwner(
  context: TenantContext | null | undefined
): asserts context is TenantContext & { role: "owner" } {
  assertRole(context, ["owner"] as const);
}

/**
 * Asserts that the actor is an organization administrator or owner.
 * Owner OR Admin operations: membership management, invitations, project assignment, organization settings.
 */
export function assertOrgAdmin(
  context: TenantContext | null | undefined
): asserts context is TenantContext & { role: "owner" | "admin" } {
  assertRole(context, ["owner", "admin"] as const);
}

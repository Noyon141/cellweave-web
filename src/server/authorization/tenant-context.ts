import type { OrganizationId } from "@/types";

export interface TenantContext {
  readonly organizationId: OrganizationId;
  readonly userId: string;
  readonly roles: readonly string[];
  readonly isSystemAdmin?: boolean;
}

export class TenantAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantAuthorizationError";
  }
}

/**
 * Validates that an untrusted organization ID string matches the active validated tenant context.
 * Prevents cross-tenant IDOR violations.
 */
export function validateTenantAccess(
  tenant: TenantContext,
  targetOrganizationId: string
): OrganizationId {
  if (!tenant || !tenant.organizationId) {
    throw new TenantAuthorizationError("Missing or unauthenticated TenantContext");
  }

  if (tenant.organizationId !== targetOrganizationId) {
    throw new TenantAuthorizationError(
      `Cross-tenant access prohibited. Context: ${tenant.organizationId}, Target: ${targetOrganizationId}`
    );
  }

  return tenant.organizationId;
}

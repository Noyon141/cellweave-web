import { eq, and } from "drizzle-orm";
import type { TenantContext, OrganizationRole } from "@/types";
import { ORGANIZATION_ROLES } from "@/types";
import { getDb, type DbClient } from "../database/client";
import { member } from "../database/schema/auth";
import { auth as defaultAuth, type Auth } from "../integrations/auth/better-auth";
import {
  TenantAuthorizationError,
  UnauthenticatedError,
  TenantContextRequiredError,
  TenantMembershipNotFoundError,
  InvalidOrganizationRoleError,
} from "./errors";

export type { TenantContext };
export {
  TenantAuthorizationError,
  UnauthenticatedError,
  TenantContextRequiredError,
  TenantMembershipNotFoundError,
  InvalidOrganizationRoleError,
};

export interface ResolveTenantContextOptions {
  /**
   * Request or Headers object to resolve the session from.
   */
  requestOrHeaders: Request | Headers;
  /**
   * Optional injected BetterAuth instance for isolated unit testing.
   */
  authClient?: Pick<Auth, "api">;
  /**
   * Optional injected Drizzle DB client for isolated unit testing.
   */
  dbClient?: DbClient;
}

/**
 * Server-Validated TenantContext Resolution (Phase 1 Identity & Tenancy)
 *
 * CRITICAL TENANT ISOLATION INVARIANTS:
 * 1. A valid BetterAuth session ALONE NEVER GRANTS TENANT ACCESS.
 * 2. TenantContext is NEVER derived from client-supplied parameters:
 *    - URL orgId / path params
 *    - query parameters (?orgId=...)
 *    - body parameters ({ organizationId: ... })
 *    - custom headers (x-organization-id, etc.)
 *    - client state / localStorage
 * 3. Fresh membership verification:
 *    Every tenant-scoped request executes a live database query against the `member` table.
 *    No membership caching is permitted in Phase 1. If membership is deleted or role is changed,
 *    it takes effect immediately on the very next request.
 * 4. Cardinality invariant:
 *    Exactly one membership record must exist for the (organizationId, userId) pair.
 *    If an impossible duplicate state is encountered, fail closed.
 * 5. Canonical return type:
 *    Returns an immutable TenantContext:
 *    {
 *      organizationId: string;
 *      userId: string;
 *      role: OrganizationRole;
 *    }
 */
export async function resolveTenantContext(
  options: ResolveTenantContextOptions
): Promise<TenantContext> {
  const { requestOrHeaders, authClient = defaultAuth, dbClient = getDb() } = options;

  // Extract standard Headers instance
  const headers = requestOrHeaders instanceof Headers ? requestOrHeaders : requestOrHeaders.headers;

  // 1. Resolve authenticated session via BetterAuth server API
  // Using auth.api.getSession({ headers })
  let sessionResult: {
    user: { id: string; email?: string | null };
    session: { id: string; userId: string; activeOrganizationId?: string | null };
  } | null = null;

  try {
    sessionResult = await (
      authClient.api.getSession as unknown as (params: {
        headers: Headers;
      }) => Promise<typeof sessionResult>
    )({
      headers,
    });
  } catch (err) {
    if (err instanceof TenantAuthorizationError) {
      throw err;
    }
    throw new UnauthenticatedError("Failed to authenticate session");
  }

  // 2. Reject unauthenticated requests
  if (!sessionResult || !sessionResult.user || !sessionResult.session) {
    throw new UnauthenticatedError("Unauthenticated session");
  }

  const { user: authenticatedUser, session: authenticatedSession } = sessionResult;

  // Verify internal session consistency
  if (!authenticatedUser.id || authenticatedSession.userId !== authenticatedUser.id) {
    throw new UnauthenticatedError("Session user identity mismatch");
  }

  // 3. Read activeOrganizationId strictly from the trusted BetterAuth session
  const activeOrgId = authenticatedSession.activeOrganizationId;

  // 4. Reject if no active organization context is established
  if (!activeOrgId || typeof activeOrgId !== "string" || activeOrgId.trim() === "") {
    throw new TenantContextRequiredError("No active organization established in session");
  }

  // 5. Query live member table using BOTH organizationId AND userId
  const memberships = await dbClient
    .select({
      id: member.id,
      organizationId: member.organizationId,
      userId: member.userId,
      role: member.role,
    })
    .from(member)
    .where(and(eq(member.organizationId, activeOrgId), eq(member.userId, authenticatedUser.id)));

  // 6. Cardinality check: Require exactly one active membership.
  // Fail closed on 0 (revoked/missing) or >1 (impossible duplicate corruption state).
  if (memberships.length === 0) {
    throw new TenantMembershipNotFoundError("Active membership not found for current tenant");
  }

  if (memberships.length > 1) {
    // Defense-in-depth: Never choose an arbitrary record if DB corruption occurs. Fail closed.
    throw new TenantAuthorizationError("Data integrity violation: multiple memberships detected");
  }

  const membershipRecord = memberships[0];
  if (!membershipRecord) {
    throw new TenantMembershipNotFoundError("Active membership not found for current tenant");
  }

  // 7. Validate that member.role conforms to the canonical OrganizationRole union
  const rawRole = membershipRecord.role;
  if (!rawRole || !ORGANIZATION_ROLES.includes(rawRole as OrganizationRole)) {
    throw new InvalidOrganizationRoleError(`Non-canonical organization role: ${String(rawRole)}`);
  }

  const canonicalRole = rawRole as OrganizationRole;

  // 8. Return immutable canonical TenantContext
  const tenantContext: TenantContext = Object.freeze({
    organizationId: membershipRecord.organizationId,
    userId: membershipRecord.userId,
    role: canonicalRole,
  });

  return tenantContext;
}

/**
 * Validates that an untrusted target organization ID string matches the active validated tenant context.
 * Prevents cross-tenant IDOR violations.
 */
export function validateTenantAccess(
  tenant: TenantContext | null | undefined,
  targetOrganizationId: string
): string {
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

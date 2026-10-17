/**
 * CellWeave Authorization & Domain Error Hierarchy (Phase 1)
 *
 * Distinguishes between:
 * - Unauthenticated (no valid session/identity)
 * - TenantContextRequired (authenticated identity without an active tenant scope)
 * - TenantMembershipNotFound (no valid active membership for the requested tenant)
 * - InvalidOrganizationRole (role in database not in canonical OrganizationRole union)
 * - TenantAuthorizationError (general authorization failure or cross-tenant boundary breach)
 * - ResourceNotFoundError (target resource not found in active tenant scope)
 * - ConflictError (state conflict, e.g. duplicate active pending invitation)
 * - ValidationError (input payload fails validation rules)
 *
 * SECURITY INVARIANT:
 * Error messages must never leak foreign tenant existence, slugs, or internal database metadata.
 */

export class TenantAuthorizationError extends Error {
  constructor(message: string = "Tenant authorization denied") {
    super(message);
    this.name = "TenantAuthorizationError";
  }
}

export class UnauthenticatedError extends TenantAuthorizationError {
  constructor(message: string = "Authentication required") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export class TenantContextRequiredError extends TenantAuthorizationError {
  constructor(message: string = "Active organization context is required for this operation") {
    super(message);
    this.name = "TenantContextRequiredError";
  }
}

export class TenantMembershipNotFoundError extends TenantAuthorizationError {
  constructor(message: string = "Active organization membership not found") {
    super(message);
    this.name = "TenantMembershipNotFoundError";
  }
}

export class InvalidOrganizationRoleError extends TenantAuthorizationError {
  constructor(message: string = "Invalid organization role assigned to membership") {
    super(message);
    this.name = "InvalidOrganizationRoleError";
  }
}

export class ResourceNotFoundError extends TenantAuthorizationError {
  constructor(message: string = "Resource not found") {
    super(message);
    this.name = "ResourceNotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string = "Resource conflict") {
    super(message);
    this.name = "ConflictError";
  }
}

export class ValidationError extends Error {
  constructor(message: string = "Validation failed") {
    super(message);
    this.name = "ValidationError";
  }
}

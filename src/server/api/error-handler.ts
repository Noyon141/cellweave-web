import { NextResponse } from "next/server";
import {
  TenantAuthorizationError,
  UnauthenticatedError,
  TenantContextRequiredError,
  TenantMembershipNotFoundError,
  InvalidOrganizationRoleError,
  ResourceNotFoundError,
  ConflictError,
  ValidationError,
} from "@/server/authorization/errors";

export function handleRouteError(error: unknown): NextResponse {
  if (error instanceof UnauthenticatedError) {
    return NextResponse.json(
      { error: "UNAUTHENTICATED", message: "Authentication required" },
      { status: 401 }
    );
  }

  // Priority check: ResourceNotFoundError extends TenantAuthorizationError
  // It must be checked before TenantAuthorizationError to return HTTP 404
  if (error instanceof ResourceNotFoundError) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "Resource not found" },
      { status: 404 }
    );
  }

  // Generic non-disclosing authorization failure response
  // TenantContextRequiredError, TenantMembershipNotFoundError, and InvalidOrganizationRoleError
  // all inherit from TenantAuthorizationError
  if (
    error instanceof TenantContextRequiredError ||
    error instanceof TenantMembershipNotFoundError ||
    error instanceof InvalidOrganizationRoleError ||
    error instanceof TenantAuthorizationError
  ) {
    return NextResponse.json(
      { error: "FORBIDDEN", message: "You are not authorized to access this resource." },
      { status: 403 }
    );
  }

  if (error instanceof ConflictError) {
    return NextResponse.json({ error: "CONFLICT", message: error.message }, { status: 409 });
  }

  if (error instanceof ValidationError) {
    return NextResponse.json({ error: "BAD_REQUEST", message: error.message }, { status: 400 });
  }

  console.error("Unhandled API Error:", error);
  return NextResponse.json(
    { error: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" },
    { status: 500 }
  );
}

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  TenantAuthorizationError,
  UnauthenticatedError,
  TenantContextRequiredError,
  TenantMembershipNotFoundError,
  InvalidOrganizationRoleError,
  ResourceNotFoundError,
  ConflictError,
  ValidationError,
  IntegrityError,
} from "@/server/authorization/errors";
import { StorageError } from "@/server/integrations/storage/storage-types";

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

  if (error instanceof IntegrityError) {
    return NextResponse.json({ error: "CONFLICT", message: error.message }, { status: 409 });
  }

  if (error instanceof ValidationError) {
    return NextResponse.json({ error: "BAD_REQUEST", message: error.message }, { status: 400 });
  }

  if (error instanceof ZodError) {
    const firstIssue = error.issues[0];
    const message = firstIssue?.message ?? "Invalid request payload";
    return NextResponse.json({ error: "BAD_REQUEST", message }, { status: 400 });
  }

  if (error instanceof SyntaxError) {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "Malformed JSON payload" },
      { status: 400 }
    );
  }

  if (error instanceof StorageError) {
    if (error.isRetryable) {
      return NextResponse.json(
        { error: "SERVICE_UNAVAILABLE", message: "Storage provider temporarily unavailable" },
        { status: 503 }
      );
    }
    if (error.code === "OBJECT_NOT_FOUND" || error.code === "MULTIPART_UPLOAD_NOT_FOUND") {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "Requested storage object not found" },
        { status: 404 }
      );
    }
    if (
      error.code === "INVALID_PART" ||
      error.code === "INVALID_OBJECT_KEY" ||
      error.code === "INVALID_FILENAME"
    ) {
      return NextResponse.json({ error: "BAD_REQUEST", message: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "STORAGE_ERROR", message: "Storage operation failed" },
      { status: 500 }
    );
  }

  console.error("Unhandled API Error:", error);
  return NextResponse.json(
    { error: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" },
    { status: 500 }
  );
}

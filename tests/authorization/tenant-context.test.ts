import { describe, it, expect } from "vitest";
import {
  validateTenantAccess,
  TenantAuthorizationError,
} from "@/server/authorization/tenant-context";
import type { TenantContext, OrganizationRole } from "@/types";

describe("Tenant Authorization Boundary Foundation", () => {
  const tenantA: TenantContext = {
    organizationId: "org_alpha",
    userId: "user_1",
    role: "scientist" as OrganizationRole,
  };

  it("permits access when requesting resources belonging to active tenant", () => {
    const verifiedOrgId = validateTenantAccess(tenantA, "org_alpha");
    expect(verifiedOrgId).toBe("org_alpha");
  });

  it("strictly rejects cross-tenant resource access attempts", () => {
    expect(() => {
      validateTenantAccess(tenantA, "org_beta");
    }).toThrow(TenantAuthorizationError);
  });

  it("rejects undefined or missing tenant context", () => {
    expect(() => {
      validateTenantAccess(null, "org_alpha");
    }).toThrow(TenantAuthorizationError);
  });
});

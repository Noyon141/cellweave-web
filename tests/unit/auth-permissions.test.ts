import { describe, it, expect } from "vitest";
import { ORGANIZATION_ROLES } from "@/types";
import {
  statement,
  roles,
  owner,
  admin,
  bioinformatician,
  scientist,
  viewer,
} from "@/server/integrations/auth/permissions";
import { getAuthConfig, authBoundary } from "@/server/integrations/auth/better-auth";
import { authClient } from "@/lib/auth-client";

describe("Phase 1 BetterAuth Custom Access Control & Organization Roles", () => {
  it("enforces canonical five-role mapping strictly matching contracts", () => {
    expect(Object.keys(roles).sort()).toEqual([...ORGANIZATION_ROLES].sort());
    expect(ORGANIZATION_ROLES).toEqual([
      "owner",
      "admin",
      "bioinformatician",
      "scientist",
      "viewer",
    ]);
  });

  it("limits statement strictly to Phase 1 identity/tenancy resources", () => {
    const resourceKeys = Object.keys(statement);
    expect(resourceKeys.sort()).toEqual(
      ["organization", "settings", "member", "invitation", "auditLog", "projectAccess"].sort()
    );

    // Verify later-phase scientific and billing resources are strictly absent
    const forbiddenResources = [
      "analysis",
      "export",
      "dataset",
      "pipeline",
      "billing",
      "project", // project lifecycle belongs to Phase 2, projectAccess is used for Phase 1
    ];
    for (const forbidden of forbiddenResources) {
      expect(resourceKeys).not.toContain(forbidden);
    }
  });

  it("grants Owner full organization, member, settings, project access, and audit log permissions", () => {
    expect(owner.statements.organization).toEqual(["update", "delete"]);
    expect(owner.statements.settings).toEqual(["read", "update"]);
    expect(owner.statements.member).toEqual(["create", "read", "update", "delete"]);
    expect(owner.statements.invitation).toEqual(["create", "read", "cancel"]);
    expect(owner.statements.auditLog).toEqual(["read"]);
    expect(owner.statements.projectAccess).toEqual(["read", "assign"]);
  });

  it("allows Admin to manage members, invitations, settings, and project access, but forbids Owner-only operations", () => {
    expect(admin.statements.member).toEqual(["create", "read", "update", "delete"]);
    expect(admin.statements.invitation).toEqual(["create", "read", "cancel"]);
    expect(admin.statements.settings).toEqual(["read", "update"]);
    expect(admin.statements.projectAccess).toEqual(["read", "assign"]);

    // Admin can update org info but CANNOT delete organization
    expect(admin.statements.organization).toContain("update");
    expect(admin.statements.organization).not.toContain("delete");

    // Admin CANNOT read audit logs (Owner-only)
    expect(admin.statements.auditLog).toEqual([]);
    expect(admin.statements.auditLog).not.toContain("read");
  });

  it("restricts Bioinformatician from organization and membership administration", () => {
    expect(bioinformatician.statements.organization).toEqual([]);
    expect(bioinformatician.statements.invitation).toEqual([]);
    expect(bioinformatician.statements.auditLog).toEqual([]);
    expect(bioinformatician.statements.member).toEqual(["read"]);
    expect(bioinformatician.statements.settings).toEqual(["read"]);
    expect(bioinformatician.statements.projectAccess).toEqual(["read"]);

    expect(bioinformatician.statements.member).not.toContain("create");
    expect(bioinformatician.statements.member).not.toContain("delete");
    expect(bioinformatician.statements.settings).not.toContain("update");
  });

  it("restricts Scientist from organization and membership administration", () => {
    expect(scientist.statements.organization).toEqual([]);
    expect(scientist.statements.invitation).toEqual([]);
    expect(scientist.statements.auditLog).toEqual([]);
    expect(scientist.statements.member).toEqual(["read"]);
    expect(scientist.statements.settings).toEqual(["read"]);
    expect(scientist.statements.projectAccess).toEqual(["read"]);

    expect(scientist.statements.member).not.toContain("create");
    expect(scientist.statements.settings).not.toContain("update");
  });

  it("restricts Viewer to read-only visibility with zero mutation or admin capabilities", () => {
    expect(viewer.statements.organization).toEqual([]);
    expect(viewer.statements.invitation).toEqual([]);
    expect(viewer.statements.auditLog).toEqual([]);
    expect(viewer.statements.member).toEqual(["read"]);
    expect(viewer.statements.settings).toEqual(["read"]);
    expect(viewer.statements.projectAccess).toEqual(["read"]);

    // Verify absolutely no write actions
    const allActions = [
      ...viewer.statements.organization,
      ...viewer.statements.invitation,
      ...viewer.statements.auditLog,
    ];
    expect(allActions).toEqual([]);
  });

  it("loads server BetterAuth configuration without exposing secrets", () => {
    const config = getAuthConfig();
    expect(config.secret).toBeDefined();
    expect(config.baseURL).toBeDefined();
    expect(config.socialProviders?.google).toBeDefined();

    // Verify architectural boundary status
    expect(authBoundary.baseURL).toBeDefined();
    expect(authBoundary.isConfigured).toBe(true);

    // Verify secret is not leaked in boundary object
    expect("secret" in authBoundary).toBe(false);
    expect("clientSecret" in authBoundary).toBe(false);
  });

  it("loads client auth configuration with matching organization access-control plugin", () => {
    expect(authClient).toBeDefined();
    expect(typeof authClient.signIn).toBe("function");
    expect(typeof authClient.signOut).toBe("function");
    expect(typeof authClient.useSession).toBe("function");
    expect(authClient.organization).toBeDefined();
  });
});

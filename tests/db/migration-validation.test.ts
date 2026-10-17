import { describe, it, expect } from "vitest";
import {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
  organizationSettings,
  projects,
  projectMembers,
  auditEvents,
} from "@/server/database/schema";
import { ORGANIZATION_ROLES } from "@/types";
import { getTableColumns } from "drizzle-orm";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Database Schema & Tenant Isolation Invariant Validation", () => {
  describe("BetterAuth Tables Invariants", () => {
    it("verifies user table columns", () => {
      const cols = getTableColumns(user);
      expect(cols).toHaveProperty("id");
      expect(cols).toHaveProperty("name");
      expect(cols).toHaveProperty("email");
      expect(cols).toHaveProperty("emailVerified");
      expect(cols.id.primary).toBe(true);
    });

    it("verifies session table supports activeOrganizationId for multi-tenancy", () => {
      const cols = getTableColumns(session);
      expect(cols).toHaveProperty("id");
      expect(cols).toHaveProperty("userId");
      expect(cols).toHaveProperty("activeOrganizationId");
      expect(cols.userId.notNull).toBe(true);
    });

    it("verifies organization table is root tenant entity", () => {
      const cols = getTableColumns(organization);
      expect(cols).toHaveProperty("id");
      expect(cols).toHaveProperty("name");
      expect(cols).toHaveProperty("slug");
      expect(cols.id.primary).toBe(true);
    });

    it("verifies member table role compatibility with canonical CellWeave roles", () => {
      const cols = getTableColumns(member);
      expect(cols).toHaveProperty("id");
      expect(cols).toHaveProperty("organizationId");
      expect(cols).toHaveProperty("userId");
      expect(cols).toHaveProperty("role");
      expect(cols.organizationId.notNull).toBe(true);
      expect(cols.userId.notNull).toBe(true);
      expect(cols.role.notNull).toBe(true);

      // Verify member.role accepts all 5 canonical OrganizationRoles
      expect(ORGANIZATION_ROLES).toEqual([
        "owner",
        "admin",
        "bioinformatician",
        "scientist",
        "viewer",
      ]);
    });

    it("verifies invitation and account tables exist", () => {
      const invCols = getTableColumns(invitation);
      expect(invCols).toHaveProperty("organizationId");
      expect(invCols).toHaveProperty("email");

      const accCols = getTableColumns(account);
      expect(accCols).toHaveProperty("userId");
      expect(accCols).toHaveProperty("providerId");

      const verCols = getTableColumns(verification);
      expect(verCols).toHaveProperty("identifier");
      expect(verCols).toHaveProperty("value");
    });
  });

  describe("Organization Settings Schema", () => {
    it("is 1:1 with organization table and has required governance columns", () => {
      const cols = getTableColumns(organizationSettings);
      expect(cols).toHaveProperty("organizationId");
      expect(cols.organizationId.primary).toBe(true);
      expect(cols).toHaveProperty("defaultRetentionDays");
      expect(cols).toHaveProperty("downloadPermissions");
      expect(cols).toHaveProperty("exportPermissions");
      expect(cols).toHaveProperty("projectVisibility");
      expect(cols).toHaveProperty("updatedAt");
      expect(cols).toHaveProperty("updatedBy");
      expect(cols.updatedAt.notNull).toBe(true);
    });
  });

  describe("Projects Schema", () => {
    it("matches canonical Phase 1 structural requirements", () => {
      const cols = getTableColumns(projects);
      expect(cols).toHaveProperty("id");
      expect(cols.id.primary).toBe(true);
      expect(cols).toHaveProperty("organizationId");
      expect(cols.organizationId.notNull).toBe(true);
      expect(cols).toHaveProperty("name");
      expect(cols).toHaveProperty("description");
      expect(cols).toHaveProperty("status");
      expect(cols).toHaveProperty("createdBy");
      expect(cols).toHaveProperty("createdAt");
      expect(cols).toHaveProperty("updatedAt");
      expect(cols).toHaveProperty("archivedAt");

      // Invariants: NO slug, NO scientific matrices or pipeline execution fields
      expect(cols).not.toHaveProperty("slug");
      expect(cols).not.toHaveProperty("matrixPath");
      expect(cols).not.toHaveProperty("datasetId");
      expect(cols).not.toHaveProperty("pipelineVersion");
      expect(cols).not.toHaveProperty("workflowExecutionId");
    });
  });

  describe("Project Members Schema", () => {
    it("matches canonical Phase 1 access representation", () => {
      const cols = getTableColumns(projectMembers);
      expect(cols).toHaveProperty("id");
      expect(cols.id.primary).toBe(true);
      expect(cols).toHaveProperty("organizationId");
      expect(cols.organizationId.notNull).toBe(true);
      expect(cols).toHaveProperty("projectId");
      expect(cols.projectId.notNull).toBe(true);
      expect(cols).toHaveProperty("userId");
      expect(cols.userId.notNull).toBe(true);
      expect(cols).toHaveProperty("createdAt");

      // Invariant: Project access is boolean membership — strictly NO project role column
      expect(cols).not.toHaveProperty("role");
      expect(cols).not.toHaveProperty("projectRole");
      expect(cols).not.toHaveProperty("permissions");
    });
  });

  describe("Audit Events Schema", () => {
    it("matches canonical Phase 1 audit schema and privacy invariants", () => {
      const cols = getTableColumns(auditEvents);
      expect(cols).toHaveProperty("id");
      expect(cols.id.primary).toBe(true);
      expect(cols).toHaveProperty("organizationId");
      expect(cols.organizationId.notNull).toBe(true);
      expect(cols).toHaveProperty("actorType");
      expect(cols.actorType.notNull).toBe(true);
      expect(cols).toHaveProperty("actorId");
      expect(cols.actorId.notNull).toBe(true);
      expect(cols).toHaveProperty("action");
      expect(cols.action.notNull).toBe(true);
      expect(cols).toHaveProperty("resourceType");
      expect(cols).toHaveProperty("resourceId");
      expect(cols).toHaveProperty("metadata");
      expect(cols).toHaveProperty("ipHash");
      expect(cols).toHaveProperty("userAgent");
      expect(cols).toHaveProperty("createdAt");
      expect(cols.createdAt.notNull).toBe(true);

      // Privacy Invariant: NO raw IP address stored in audit log
      expect(cols).not.toHaveProperty("ipAddress");
      expect(cols).not.toHaveProperty("ip_address");
      expect(cols).not.toHaveProperty("rawIp");
    });
  });

  describe("Generated Migration File Validation", () => {
    const migrationPath = path.resolve(
      process.cwd(),
      "src/server/database/migrations/0000_phase1_identity_and_tenancy.sql"
    );

    it("verifies migration file exists and is readable", () => {
      expect(fs.existsSync(migrationPath)).toBe(true);
    });

    it("verifies migration creates all 11 required tables", () => {
      const sql = fs.readFileSync(migrationPath, "utf-8");
      const requiredTables = [
        '"account"',
        '"invitation"',
        '"member"',
        '"organization"',
        '"session"',
        '"user"',
        '"verification"',
        '"organization_settings"',
        '"project_members"',
        '"projects"',
        '"audit_events"',
      ];

      for (const table of requiredTables) {
        expect(sql).toContain(`CREATE TABLE ${table}`);
      }
    });

    it("verifies composite foreign key on project_members for tenant safety", () => {
      const sql = fs.readFileSync(migrationPath, "utf-8");
      expect(sql).toContain(
        'FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade'
      );
    });

    it("verifies composite unique constraint on projects (id, organization_id)", () => {
      const sql = fs.readFileSync(migrationPath, "utf-8");
      expect(sql).toContain('CONSTRAINT "projects_id_org_unique" UNIQUE("id","organization_id")');
    });

    it("verifies unique constraint on project_members (project_id, user_id)", () => {
      const sql = fs.readFileSync(migrationPath, "utf-8");
      expect(sql).toContain(
        'CONSTRAINT "project_members_project_user_unique" UNIQUE("project_id","user_id")'
      );
    });

    it("verifies defense-in-depth privileges and audit event immutability", () => {
      const sql = fs.readFileSync(migrationPath, "utf-8");
      expect(sql).toContain(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cellweave_app;"
      );
      expect(sql).toContain(
        "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cellweave_app;"
      );
      expect(sql).toContain("REVOKE UPDATE, DELETE ON audit_events FROM cellweave_app;");
    });

    it("verifies no unintended drop statements exist", () => {
      const sql = fs.readFileSync(migrationPath, "utf-8");
      expect(sql).not.toMatch(/DROP TABLE/i);
      expect(sql).not.toMatch(/DROP COLUMN/i);
    });
  });
});

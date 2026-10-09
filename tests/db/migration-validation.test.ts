import { describe, it, expect } from "vitest";
import {
  organizations,
  organizationSettings,
  projects,
  auditEvents,
} from "@/server/database/schema";
import { getTableColumns } from "drizzle-orm";

describe("Database Schema & Tenant Isolation Invariant Validation", () => {
  it("enforces organization_id on all tenant-owned domain tables", () => {
    const projectCols = getTableColumns(projects);
    expect(projectCols).toHaveProperty("organizationId");
    expect(projectCols.organizationId.notNull).toBe(true);

    const settingsCols = getTableColumns(organizationSettings);
    expect(settingsCols).toHaveProperty("organizationId");
    expect(settingsCols.organizationId.notNull).toBe(true);

    const auditCols = getTableColumns(auditEvents);
    expect(auditCols).toHaveProperty("organizationId");
    expect(auditCols.organizationId.notNull).toBe(true);
  });

  it("verifies organizations table primary key", () => {
    const orgCols = getTableColumns(organizations);
    expect(orgCols).toHaveProperty("id");
    expect(orgCols.id.primary).toBe(true);
  });
});

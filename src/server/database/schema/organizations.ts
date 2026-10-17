import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organization, user } from "./auth";

// Backward-compatible alias for Phase 0 callers expecting 'organizations'
export { organization as organizations } from "./auth";

/**
 * Organization Settings Schema (Phase 1 Identity & Tenancy)
 * 1:1 governance settings attached to the BetterAuth organization entity.
 */
export const organizationSettings = pgTable("organization_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  defaultRetentionDays: integer("default_retention_days"),
  downloadPermissions: text("download_permissions"),
  exportPermissions: text("export_permissions"),
  projectVisibility: text("project_visibility"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
});

export const organizationSettingsRelations = relations(organizationSettings, ({ one }) => ({
  organization: one(organization, {
    fields: [organizationSettings.organizationId],
    references: [organization.id],
  }),
  updater: one(user, {
    fields: [organizationSettings.updatedBy],
    references: [user.id],
  }),
}));

import { pgTable, text, timestamp, index, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organization, user } from "./auth";

/**
 * Projects Schema (Phase 1 Structural Foundation)
 * Encapsulates tenant-isolated project boundaries.
 * Invariant: Must contain unique (id, organization_id) to serve as composite FK target.
 */
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").default("active").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    unique("projects_id_org_unique").on(table.id, table.organizationId),
    index("projects_org_idx").on(table.organizationId),
    index("projects_org_status_idx").on(table.organizationId, table.status),
    index("projects_created_at_idx").on(table.createdAt),
  ]
);

/**
 * Project Members Schema (Phase 1 Project-Level Access Control)
 * Invariants:
 * 1. Project access is boolean membership (NO project role column).
 * 2. Composite FK (project_id, organization_id) -> projects(id, organization_id) guarantees
 *    that membership cannot cross organization boundaries.
 */
export const projectMembers = pgTable(
  "project_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("project_members_project_user_unique").on(table.projectId, table.userId),
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: "project_members_project_org_fk",
    }).onDelete("cascade"),
    index("project_members_org_idx").on(table.organizationId),
    index("project_members_project_idx").on(table.projectId),
    index("project_members_user_idx").on(table.userId),
  ]
);

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organization, {
    fields: [projects.organizationId],
    references: [organization.id],
  }),
  creator: one(user, {
    fields: [projects.createdBy],
    references: [user.id],
  }),
  members: many(projectMembers),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  organization: one(organization, {
    fields: [projectMembers.organizationId],
    references: [organization.id],
  }),
  project: one(projects, {
    fields: [projectMembers.projectId],
    references: [projects.id],
  }),
  user: one(user, {
    fields: [projectMembers.userId],
    references: [user.id],
  }),
}));

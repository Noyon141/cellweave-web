import { pgTable, text, timestamp, index, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organization, user } from "./auth";
import { projects } from "./projects";
import { samples } from "./samples";

/**
 * Experiments Schema (Phase 2 Biological Experiment Boundary)
 *
 * Invariant: Must contain unique (id, organization_id) to serve as composite FK target
 * for downstream child entities (samples).
 */
export const experiments = pgTable(
  "experiments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    organism: text("organism"),
    tissue: text("tissue"),
    diseaseContext: text("disease_context"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("experiments_id_org_unique").on(table.id, table.organizationId),
    foreignKey({
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
      name: "experiments_project_org_fk",
    }).onDelete("cascade"),
    index("experiments_org_project_idx").on(table.organizationId, table.projectId),
  ]
);

export const experimentsRelations = relations(experiments, ({ one, many }) => ({
  organization: one(organization, {
    fields: [experiments.organizationId],
    references: [organization.id],
  }),
  project: one(projects, {
    fields: [experiments.projectId],
    references: [projects.id],
  }),
  creator: one(user, {
    fields: [experiments.createdBy],
    references: [user.id],
  }),
  samples: many(samples),
}));

import { pgTable, text, jsonb, index, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organization } from "./auth";
import { experiments } from "./experiments";

/**
 * Samples Schema (Phase 2 Biological/Technical Sample Coordinate)
 *
 * Invariant: sampleKey is strictly unique within experimentId.
 * Composite FK (experimentId, organizationId) -> experiments(id, organizationId) guarantees
 * cross-tenant containment.
 */
export const samples = pgTable(
  "samples",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    experimentId: text("experiment_id").notNull(),
    sampleKey: text("sample_key").notNull(),
    displayName: text("display_name"),
    condition: text("condition"),
    batch: text("batch"),
    biologicalReplicate: text("biological_replicate"),
    technicalReplicate: text("technical_replicate"),
    metadataJson: jsonb("metadata_json").default({}).notNull(),
  },
  (table) => [
    unique("samples_exp_key_unique").on(table.experimentId, table.sampleKey),
    foreignKey({
      columns: [table.experimentId, table.organizationId],
      foreignColumns: [experiments.id, experiments.organizationId],
      name: "samples_experiment_org_fk",
    }).onDelete("cascade"),
    index("samples_org_experiment_idx").on(table.organizationId, table.experimentId),
  ]
);

export const samplesRelations = relations(samples, ({ one }) => ({
  organization: one(organization, {
    fields: [samples.organizationId],
    references: [organization.id],
  }),
  experiment: one(experiments, {
    fields: [samples.experimentId],
    references: [experiments.id],
  }),
}));

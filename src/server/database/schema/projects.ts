import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Projects Schema (Phase 0 Structural Scaffold)
 * Demonstrates the tenant isolation pattern (organizationId foreign key & index).
 * Full project lifecycle, metadata, and permissions activate in Phase 2.
 */
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("projects_org_idx").on(table.organizationId)]
);

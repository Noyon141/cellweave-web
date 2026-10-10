import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Audit Events Schema (Phase 0 Structural Scaffold)
 * Demonstrates the append-only tenant isolation pattern (organizationId foreign key & index).
 * Full audit framework, actor classification, and metadata activate in Phase 1.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("audit_events_org_idx").on(table.organizationId)]
);

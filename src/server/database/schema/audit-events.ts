import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_events_org_idx").on(table.organizationId),
    index("audit_events_resource_idx").on(table.resourceType, table.resourceId),
    index("audit_events_created_at_idx").on(table.createdAt),
  ]
);

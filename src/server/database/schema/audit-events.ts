import { jsonb, pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organization } from "./auth";

/**
 * Audit Events Schema (Phase 1 Canonical Audit Framework)
 * Append-only immutable log for all security, tenancy, and governance events.
 *
 * Privacy Invariants:
 * - NO raw IP addresses allowed (use ipHash for correlation).
 * - actorType is open text (accommodating user, system, api_key, etc.).
 * - organizationId is mandatory and indexed for strict tenant-bounded auditing.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    metadata: jsonb("metadata"),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_events_org_idx").on(table.organizationId),
    index("audit_events_actor_idx").on(table.actorId),
    index("audit_events_action_idx").on(table.action),
    index("audit_events_created_at_idx").on(table.createdAt),
  ]
);

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  organization: one(organization, {
    fields: [auditEvents.organizationId],
    references: [organization.id],
  }),
}));

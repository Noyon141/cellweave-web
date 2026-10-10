import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Organizations Schema (Phase 0 Structural Scaffold)
 * Root tenant entity. Full organization governance, settings, and RBAC activate in Phase 1.
 */
export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

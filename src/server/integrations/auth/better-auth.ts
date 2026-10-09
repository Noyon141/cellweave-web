import type { BetterAuthOptions } from "better-auth";
import { env } from "@/server/config/env";

/**
 * BetterAuth Integration Boundary (Phase 0 Foundation)
 * Defines authentication configuration options.
 * Live authentication routes and RBAC enforcement activate in Phase 1.
 */
export function getAuthConfig(): BetterAuthOptions {
  return {
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: {
      provider: "pg",
      url: env.DATABASE_URL,
    },
    emailAndPassword: {
      enabled: true,
    },
  };
}

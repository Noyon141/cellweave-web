import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { getDb } from "@/server/database/client";
import { env } from "@/server/config/env";
import { ac, roles } from "./permissions";

/**
 * BetterAuth Configuration Builder (Phase 1 Identity & Tenancy)
 * Configures the database-backed BetterAuth instance with:
 * - Drizzle ORM adapter connected to Neon PostgreSQL
 * - Google Social Provider for OAuth 2.0 authentication
 * - Custom Organization plugin using CellWeave's 5 canonical roles and access control
 */
export function getAuthConfig(): BetterAuthOptions {
  return {
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(getDb(), {
      provider: "pg",
    }),
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days database session lifetime
      updateAge: 60 * 60 * 24, // Refresh session every 24 hours
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes cache for hot path requests
      },
    },
    plugins: [
      organization({
        ac,
        roles,
      }),
    ],
  };
}

/**
 * Authoritative Server-Side BetterAuth Instance
 */
export const auth = betterAuth(getAuthConfig());

export type Auth = typeof auth;

/**
 * Architectural Integration Boundary Metadata
 */
export interface AuthIntegrationBoundary {
  readonly baseURL: string;
  readonly isConfigured: boolean;
}

export const authBoundary: AuthIntegrationBoundary = {
  baseURL: env.BETTER_AUTH_URL,
  isConfigured: Boolean(env.BETTER_AUTH_SECRET && env.BETTER_AUTH_URL),
};

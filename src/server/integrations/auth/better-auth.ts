import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { getDb } from "@/server/database/client";
import { env } from "@/server/config/env";
import { ac, roles } from "./permissions";

/**
 * BetterAuth Configuration Builder (Phase 1 Identity & Tenancy)
 *
 * CRITICAL AUTHORIZATION INVARIANT:
 * A valid BetterAuth session alone NEVER grants tenant access.
 * Tenant-scoped requests must independently resolve a validated TenantContext
 * verifying:
 *   1. Authenticated user identity
 *   2. Server-validated activeOrganizationId (never trusting browser-supplied organizationId)
 *   3. Active membership record in the organization
 *   4. Validated organization role
 * Membership deletion or role changes must immediately be reflected by fresh
 * server-side authorization checks on each request.
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
    // Session strategy: Pure database-backed sessions.
    // Cookie cache is explicitly DISABLED in Phase 1 to guarantee deterministic,
    // immediate revocation of membership and privileges on every server-validated request.
    // Note: expiresIn (7 days) and updateAge (24 hours) are operational implementation decisions,
    // not architectural master-design requirements.
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days database session lifetime (implementation decision)
      updateAge: 60 * 60 * 24, // 24 hours session touch interval (implementation decision)
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

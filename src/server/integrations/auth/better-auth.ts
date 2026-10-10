import type { BetterAuthOptions } from "better-auth";
import { env } from "@/server/config/env";

/**
 * BetterAuth Integration Boundary (Phase 0 Structural Scaffold)
 * Defines the architectural configuration contract for authentication.
 * Full authentication flows (Google OAuth, email/password, BetterAuth organizations)
 * and RBAC activate in Phase 1.
 */
export interface AuthIntegrationBoundary {
  readonly baseURL: string;
  readonly isConfigured: boolean;
}

export function getAuthConfig(): BetterAuthOptions {
  return {
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
  };
}

export const authBoundary: AuthIntegrationBoundary = {
  baseURL: env.BETTER_AUTH_URL,
  isConfigured: Boolean(env.BETTER_AUTH_SECRET && env.BETTER_AUTH_URL),
};

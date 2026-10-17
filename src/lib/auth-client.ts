import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { ac, roles } from "@/server/integrations/auth/permissions";

/**
 * BetterAuth React Client Helper (Advisory UI Helpers Only)
 * Configured with identical custom access control and canonical roles as the server.
 * Invariant: Server-side authorization remains strictly authoritative.
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  plugins: [
    organizationClient({
      ac,
      roles,
    }),
  ],
});

export const { signIn, signOut, signUp, useSession, organization: clientOrganization } = authClient;

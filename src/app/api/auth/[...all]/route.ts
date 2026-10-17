import { auth } from "@/server/integrations/auth/better-auth";
import { toNextJsHandler } from "better-auth/next-js";

/**
 * BetterAuth API Route Handlers (Phase 1 Identity)
 * Thin Route Handler: delegates directly to the configured BetterAuth instance.
 * No CellWeave business or scientific logic lives in this route file.
 */
export const { GET, POST } = toNextJsHandler(auth.handler);

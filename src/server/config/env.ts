import { z } from "zod";

/**
 * Authoritative Environment Configuration Schema
 * Strictly validates runtime dependencies for CellWeave Web.
 * Placeholder defaults for production/runtime secrets are strictly prohibited.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),

  // Neon Database
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://postgres:postgres@localhost:5432/cellweave_dev"),
  // Internal Phase 3 connection only. Validated lazily by the dedicated factory.
  // Absence must not prevent ordinary web startup or select DATABASE_URL.
  IMPORT_FINALIZER_DATABASE_URL: z.string().optional(),

  // BetterAuth (Strictly required in real DEV/STAGING runtimes; no placeholder fallback defaults)
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters for high-entropy signing"),
  BETTER_AUTH_URL: z.string().url("BETTER_AUTH_URL must be a valid URL"),

  // Audit IP Privacy Key (Keyed HMAC for privacy-preserving client IP pseudonymization)
  AUDIT_IP_HASH_SECRET: z
    .string()
    .min(16, "AUDIT_IP_HASH_SECRET must be at least 16 characters")
    .default("cellweave_audit_ip_hash_salt_dev_local_secret"),

  // Google OAuth (Phase 1 Identity; strictly required in real DEV/STAGING runtimes)
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),

  // Cloudflare R2
  R2_ACCOUNT_ID: z.string().default("placeholder_r2_account_id"),
  R2_ACCESS_KEY_ID: z.string().default("placeholder_r2_access_key_id"),
  R2_SECRET_ACCESS_KEY: z.string().default("placeholder_r2_secret_access_key"),
  R2_BUCKET_NAME: z.string().default("cellweave-datasets-dev"),

  // Polar
  POLAR_ACCESS_TOKEN: z.string().default("polar_at_placeholder"),
  POLAR_WEBHOOK_SECRET: z.string().default("polar_wh_placeholder"),

  // Temporal Cloud
  TEMPORAL_ADDRESS: z.string().default("cellweave.tmprl.cloud:7233"),
  TEMPORAL_NAMESPACE: z.string().default("cellweave-dev.default"),
  TEMPORAL_API_KEY: z.string().optional(),
  TEMPORAL_CLIENT_CERT: z.string().optional(),
  TEMPORAL_CLIENT_KEY: z.string().optional(),

  // Resend
  RESEND_API_KEY: z.string().default("re_placeholder"),

  // Sentry
  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let parsedEnv: Env | null = null;

export function getEnv(): Env {
  if (!parsedEnv) {
    const rawEnv = {
      ...process.env,
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? process.env.BETTERAUTH_URL,
    };
    const result = envSchema.safeParse(rawEnv);
    if (!result.success) {
      const formatted = result.error.format();
      // Safe error reporting: never print secret values
      console.error("Environment validation failed for required variables");
      throw new Error(`Environment validation failed: ${JSON.stringify(formatted)}`);
    }
    parsedEnv = result.data;
  }
  return parsedEnv;
}

/**
 * Dynamic proxy delegating to validated environment without early static crash.
 */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return getEnv()[prop as keyof Env];
  },
});

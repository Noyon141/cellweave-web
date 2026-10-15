import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),

  // Neon Database
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://postgres:postgres@localhost:5432/cellweave_dev"),

  // BetterAuth
  BETTER_AUTH_SECRET: z
    .string()
    .min(1)
    .default("placeholder_secret_32_characters_minimum_length_required"),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),

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
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const formatted = result.error.format();
      console.error("Invalid environment variables:", formatted);
      throw new Error(`Environment validation failed: ${JSON.stringify(formatted)}`);
    }
    parsedEnv = result.data;
  }
  return parsedEnv;
}

export const env = getEnv();

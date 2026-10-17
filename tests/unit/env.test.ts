import { describe, it, expect } from "vitest";
import { getEnv, envSchema } from "@/server/config/env";

describe("Environment Configuration Strategy", () => {
  const validBaseEnv = {
    NODE_ENV: "development",
    PORT: 3000,
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cellweave_dev",
    BETTER_AUTH_SECRET: "test_secret_that_is_at_least_32_characters_long_for_entropy",
    BETTER_AUTH_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "test_google_client_id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "test_google_client_secret_xyz123",
  };

  it("passes when valid configuration is provided", () => {
    const result = envSchema.safeParse(validBaseEnv);
    expect(result.success).toBe(true);
  });

  it("successfully reads test-injected configuration via getEnv()", () => {
    const config = getEnv();
    expect(config.NODE_ENV).toBe("test");
    expect(config.BETTER_AUTH_SECRET).toBeDefined();
    expect(config.BETTER_AUTH_URL).toBe("http://localhost:3000");
    expect(config.GOOGLE_CLIENT_ID).toBeDefined();
    expect(config.GOOGLE_CLIENT_SECRET).toBeDefined();
  });

  it("real runtime validation rejects missing BETTER_AUTH_SECRET", () => {
    const { BETTER_AUTH_SECRET: _, ...envWithoutSecret } = validBaseEnv;
    const result = envSchema.safeParse(envWithoutSecret);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.format().BETTER_AUTH_SECRET).toBeDefined();
    }
  });

  it("real runtime validation rejects short/low-entropy BETTER_AUTH_SECRET (<32 chars)", () => {
    const envWithShortSecret = {
      ...validBaseEnv,
      BETTER_AUTH_SECRET: "short_secret_under_32_chars",
    };
    const result = envSchema.safeParse(envWithShortSecret);
    expect(result.success).toBe(false);
  });

  it("real runtime validation rejects missing BETTER_AUTH_URL", () => {
    const { BETTER_AUTH_URL: _, ...envWithoutUrl } = validBaseEnv;
    const result = envSchema.safeParse(envWithoutUrl);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.format().BETTER_AUTH_URL).toBeDefined();
    }
  });

  it("real runtime validation rejects invalid BETTER_AUTH_URL", () => {
    const envWithInvalidUrl = {
      ...validBaseEnv,
      BETTER_AUTH_URL: "not-a-valid-url",
    };
    const result = envSchema.safeParse(envWithInvalidUrl);
    expect(result.success).toBe(false);
  });

  it("real runtime validation rejects missing GOOGLE_CLIENT_ID", () => {
    const { GOOGLE_CLIENT_ID: _, ...envWithoutClientId } = validBaseEnv;
    const result = envSchema.safeParse(envWithoutClientId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.format().GOOGLE_CLIENT_ID).toBeDefined();
    }
  });

  it("real runtime validation rejects missing GOOGLE_CLIENT_SECRET", () => {
    const { GOOGLE_CLIENT_SECRET: _, ...envWithoutClientSecret } = validBaseEnv;
    const result = envSchema.safeParse(envWithoutClientSecret);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.format().GOOGLE_CLIENT_SECRET).toBeDefined();
    }
  });
});

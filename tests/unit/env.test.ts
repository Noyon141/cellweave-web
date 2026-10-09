import { describe, it, expect } from "vitest";
import { getEnv } from "@/server/config/env";

describe("Environment Configuration Strategy", () => {
  it("successfully parses default configuration for development/testing", () => {
    const config = getEnv();
    expect(config.NODE_ENV).toBeDefined();
    expect(config.DATABASE_URL).toBeDefined();
    expect(config.BETTER_AUTH_SECRET).toBeDefined();
    expect(config.R2_BUCKET_NAME).toBeDefined();
    expect(config.POLAR_ACCESS_TOKEN).toBeDefined();
  });
});

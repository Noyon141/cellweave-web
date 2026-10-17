import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    exclude: ["tests/smoke/**", "node_modules/**", ".next/**"],
    env: {
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: "test_secret_that_is_at_least_32_characters_long_for_entropy",
      BETTER_AUTH_URL: "http://localhost:3000",
      GOOGLE_CLIENT_ID: "test_google_client_id.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "test_google_client_secret_xyz123",
      AUDIT_IP_HASH_SECRET: "test_audit_ip_hash_secret_minimum_16_chars",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});

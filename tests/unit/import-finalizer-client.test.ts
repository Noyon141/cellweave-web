import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const config: { DATABASE_URL: string; IMPORT_FINALIZER_DATABASE_URL?: string } = {
    DATABASE_URL: "postgresql://cellweave_app_runtime:test@localhost/test",
  };
  const query = vi.fn();
  const end = vi.fn();
  const Pool = vi.fn(function (options: { connectionString: string }) {
    return { query, end, options };
  });
  const drizzle = vi.fn((pool: unknown) => ({ pool }));
  return { config, query, end, Pool, drizzle };
});

vi.mock("@/server/config/env", () => ({ env: mocks.config }));
vi.mock("@neondatabase/serverless", () => ({ Pool: mocks.Pool }));
vi.mock("drizzle-orm/neon-serverless", () => ({ drizzle: mocks.drizzle }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  delete mocks.config.IMPORT_FINALIZER_DATABASE_URL;
  mocks.query.mockResolvedValue({ rows: [{ current_user: "cellweave_import_finalizer" }] });
  mocks.end.mockResolvedValue(undefined);
});

describe("isolated trusted finalizer connection", () => {
  it.each([
    undefined,
    "",
    " ",
    "not a URL",
    ...["cellweave_app_runtime", "cellweave_app", "neondb_owner"].map(
      (role) => `postgresql://${role}:test@localhost/test`
    ),
  ])("fails closed without a dedicated valid role URL: %s", async (value) => {
    mocks.config.IMPORT_FINALIZER_DATABASE_URL = value;
    const { getImportFinalizerDb } = await import("@/server/database/import-finalizer-client");
    await expect(getImportFinalizerDb()).rejects.toMatchObject({
      name: "DatasetImportFinalizationConfigurationError",
    });
    expect(mocks.Pool).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("keeps runtime and finalizer pools separate and shares concurrent initialization", async () => {
    const url = "postgresql://cellweave_import_finalizer:test@localhost/test";
    mocks.config.IMPORT_FINALIZER_DATABASE_URL = url;
    const { getDb } = await import("@/server/database/client");
    const { getImportFinalizerDb } = await import("@/server/database/import-finalizer-client");
    const runtime = getDb();
    const [first, second] = await Promise.all([getImportFinalizerDb(), getImportFinalizerDb()]);
    expect(first).toBe(second);
    expect(await getImportFinalizerDb()).toBe(first);
    expect(first).not.toBe(runtime);
    expect(getDb()).toBe(runtime);
    expect(mocks.Pool.mock.calls).toEqual([
      [{ connectionString: mocks.config.DATABASE_URL }],
      [{ connectionString: url }],
    ]);
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith("SELECT current_user");
  });

  it("rejects an unexpected effective current_user and closes the rejected pool", async () => {
    mocks.config.IMPORT_FINALIZER_DATABASE_URL =
      "postgresql://cellweave_import_finalizer:test@localhost/test";
    mocks.query.mockResolvedValue({ rows: [{ current_user: "neondb_owner" }] });
    const { getImportFinalizerDb } = await import("@/server/database/import-finalizer-client");
    await expect(getImportFinalizerDb()).rejects.toMatchObject({
      name: "DatasetImportFinalizationSecurityError",
    });
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.drizzle).not.toHaveBeenCalled();
  });

  it("redacts connection failures, closes the pool and allows a later initialization", async () => {
    mocks.config.IMPORT_FINALIZER_DATABASE_URL =
      "postgresql://cellweave_import_finalizer:test@localhost/test";
    mocks.query.mockRejectedValueOnce(new Error("secret URL and SQL details"));
    const { getImportFinalizerDb } = await import("@/server/database/import-finalizer-client");
    await expect(getImportFinalizerDb()).rejects.toMatchObject({
      name: "DatasetImportFinalizationDatabaseError",
      message: "Dataset import finalization database operation failed",
    });
    expect(mocks.end).toHaveBeenCalledOnce();
    await getImportFinalizerDb();
    expect(mocks.Pool).toHaveBeenCalledTimes(2);
  });
});

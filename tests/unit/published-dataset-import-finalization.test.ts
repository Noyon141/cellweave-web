import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  finalizePublishedDatasetImport,
  type FinalizePublishedDatasetImportInput,
} from "@/server/services/published-dataset-import-finalization";
import { hashIpAddress } from "@/server/services/audit-privacy";

const mocks = vi.hoisted(() => {
  const execute = vi.fn<(query: SQL) => Promise<{ rows: unknown[] }>>();
  return { execute, getDb: vi.fn(), getFinalizer: vi.fn() };
});
vi.mock("@/server/database/import-finalizer-client", () => ({
  getImportFinalizerDb: mocks.getFinalizer,
}));
vi.mock("@/server/database/client", () => ({ getDb: mocks.getDb }));

function input(): FinalizePublishedDatasetImportInput {
  return {
    context: { organizationId: "org_active", userId: "user_actor", role: "scientist" },
    datasetVersionId: "dsv_target",
    publicationResult: {
      datasetVersionId: "dsv_target",
      canonicalChecksum: "a".repeat(64),
      byteSize: 100,
      status: "PUBLISHED",
    },
    scientificFacts: {
      organism: "human",
      geneIdScheme: "ENSEMBL",
      referenceBuild: null,
      cellCount: 100,
      geneCount: 50,
    },
  };
}

// Models malformed runtime input without asserting it is a valid TypeScript contract.
function invoke(value: unknown): Promise<unknown> {
  return Reflect.apply(finalizePublishedDatasetImport, undefined, [value]);
}

function callQuery(index = 0) {
  const query = mocks.execute.mock.calls[index]?.[0];
  if (!query) throw new Error("Missing SQL invocation");
  return new PgDialect().sqlToQuery(query);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDb.mockImplementation(() => {
    throw new Error("Ordinary runtime must not be used");
  });
  mocks.getFinalizer.mockResolvedValue({ execute: mocks.execute });
  mocks.execute.mockResolvedValue({
    rows: [
      {
        status: "FINALIZED",
        canonical_artifact_key: "server-derived-key",
        finalized_at: "2026-10-24T00:00:00Z",
      },
    ],
  });
});

describe("trusted published import finalization", () => {
  it.each(["PUBLISHED", "ALREADY_PRESENT"] as const)(
    "finalizes %s exactly once through the dedicated connection",
    async (status) => {
      const value = input();
      value.publicationResult = { ...value.publicationResult, status };
      value.auditMetadata = { clientIp: "203.0.113.1", userAgent: " internal-agent " };
      const result = await finalizePublishedDatasetImport(value);
      expect(result).toEqual({
        datasetVersionId: value.datasetVersionId,
        canonicalChecksum: value.publicationResult.canonicalChecksum,
        status: "FINALIZED",
        finalizedAt: new Date("2026-10-24T00:00:00Z"),
      });
      expect(mocks.getDb).not.toHaveBeenCalled();
      expect(mocks.getFinalizer).toHaveBeenCalledOnce();
      expect(mocks.execute).toHaveBeenCalledOnce();
      const query = callQuery();
      expect(query.sql).toMatch(/^SELECT \* FROM public\.finalize_dataset_version_import\(/);
      expect(query.params).toEqual([
        "org_active",
        "dsv_target",
        "a".repeat(64),
        "human",
        "ENSEMBL",
        null,
        100,
        50,
        "user",
        "user_actor",
        hashIpAddress("203.0.113.1"),
        "internal-agent",
        expect.stringMatching(
          /^aud_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
      ]);
      expect(query.sql).not.toMatch(/UPDATE |INSERT /);
    }
  );

  it.each([undefined, null, "FAILED", "published", "", 1])(
    "rejects invalid status %s before connection creation",
    async (status) => {
      const value = input();
      await expect(
        invoke({ ...value, publicationResult: { ...value.publicationResult, status } })
      ).rejects.toThrow();
      expect(mocks.getFinalizer).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
    }
  );

  it("rejects mismatched dataset versions before connection creation", async () => {
    const value = input();
    value.publicationResult = { ...value.publicationResult, datasetVersionId: "dsv_other" };
    await expect(finalizePublishedDatasetImport(value)).rejects.toMatchObject({
      name: "DatasetImportFinalizationSecurityError",
    });
    expect(mocks.getFinalizer).not.toHaveBeenCalled();
  });

  it.each([
    "A".repeat(64),
    "a".repeat(63),
    "a".repeat(65),
    "g".repeat(64),
    " " + "a".repeat(64),
    "a".repeat(64) + " ",
    "a".repeat(64) + "\n",
    null,
    123,
  ])("rejects invalid checksum %s", async (canonicalChecksum) => {
    const value = input();
    await expect(
      invoke({ ...value, publicationResult: { ...value.publicationResult, canonicalChecksum } })
    ).rejects.toThrow();
    expect(mocks.getFinalizer).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, NaN, Infinity, "100", null, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid byteSize %s",
    async (byteSize) => {
      const value = input();
      await expect(
        invoke({ ...value, publicationResult: { ...value.publicationResult, byteSize } })
      ).rejects.toThrow();
      expect(mocks.getFinalizer).not.toHaveBeenCalled();
    }
  );

  it("accepts zero byteSize as a contract value without passing it to SQL", async () => {
    const value = input();
    value.publicationResult = { ...value.publicationResult, byteSize: 0 };
    value.scientificFacts.referenceBuild = "GRCh38";
    await finalizePublishedDatasetImport(value);
    expect(callQuery().params).toHaveLength(13);
    expect(callQuery().params[5]).toBe("GRCh38");
  });

  for (const field of ["cellCount", "geneCount"] as const) {
    it.each([0, -1, 1.5, NaN, Infinity, "100", null, 2147483648])(
      `rejects invalid ${field}: %s`,
      async (count) => {
        const value = input();
        await expect(
          invoke({ ...value, scientificFacts: { ...value.scientificFacts, [field]: count } })
        ).rejects.toThrow();
        expect(mocks.getFinalizer).not.toHaveBeenCalled();
      }
    );
  }

  it.each([
    "organizationId",
    "canonicalChecksum",
    "sourceChecksum",
    "canonicalArtifactKey",
    "importId",
    "actorId",
  ])("rejects parallel caller authority: %s", async (field) => {
    await expect(invoke({ ...input(), [field]: "untrusted" })).rejects.toThrow();
    expect(mocks.getFinalizer).not.toHaveBeenCalled();
  });

  it("maps cross-tenant misses to a non-disclosing security error", async () => {
    mocks.execute.mockRejectedValue(
      new Error("DATASET_VERSION_NOT_FOUND: secret foreign tenant and ID")
    );
    await expect(finalizePublishedDatasetImport(input())).rejects.toMatchObject({
      name: "DatasetImportFinalizationSecurityError",
      message: "Dataset import finalization is unavailable in this security context",
    });
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("accepts exact replay without retry and generates distinct UUIDv7 audit candidates", async () => {
    mocks.execute.mockResolvedValue({
      rows: [
        {
          status: "ALREADY_FINALIZED",
          canonical_artifact_key: "server-derived-key",
          finalized_at: new Date("2026-10-24T00:00:00Z"),
        },
      ],
    });
    const first = await finalizePublishedDatasetImport(input());
    expect(first.status).toBe("ALREADY_FINALIZED");
    expect(mocks.execute).toHaveBeenCalledOnce();
    const second = await finalizePublishedDatasetImport(input());
    expect(second).toEqual(first);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(callQuery(0).params[12]).not.toBe(callQuery(1).params[12]);
  });

  it.each([
    "FINALIZATION_CONFLICT",
    "CONCURRENT_FINALIZATION_CONFLICT",
    "UPLOAD_SESSION_STATE_CONFLICT",
    "SOURCE_FORMAT_MISMATCH",
  ])("redacts and types SQL conflict %s", async (code) => {
    mocks.execute.mockRejectedValue(
      new Error("SQL query wrapper", { cause: new Error(`${code}: secret scientific facts`) })
    );
    await expect(finalizePublishedDatasetImport(input())).rejects.toMatchObject({
      name: "DatasetImportFinalizationConflictError",
      message: "Dataset import finalization conflicts with persisted state",
    });
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("redacts unrecognized PostgreSQL failures", async () => {
    mocks.execute.mockRejectedValue(new Error("postgresql://secret SQL and other tenant data"));
    await expect(finalizePublishedDatasetImport(input())).rejects.toMatchObject({
      name: "DatasetImportFinalizationDatabaseError",
      message: "Dataset import finalization database operation failed",
    });
  });

  it("does not retain a raw database error as cause or serialize its details", async () => {
    mocks.execute.mockRejectedValue(new Error("sensitive database URL and SQL"));
    const error: unknown = await finalizePublishedDatasetImport(input()).catch(
      (caught: unknown) => caught
    );
    if (!(error instanceof Error)) throw new Error("Expected a controlled error");
    expect(error.cause).toBeUndefined();
    expect(error.message + error.stack + JSON.stringify(error)).not.toContain("sensitive");
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it.each([
    { rows: [] },
    { rows: [{ status: "UNEXPECTED" }] },
    { rows: [{ status: "FINALIZED", canonical_artifact_key: "key", finalized_at: "invalid" }] },
  ])("rejects malformed database results", async ({ rows }) => {
    mocks.execute.mockResolvedValue({ rows });
    await expect(finalizePublishedDatasetImport(input())).rejects.toMatchObject({
      name: "DatasetImportFinalizationDatabaseError",
    });
    expect(mocks.execute).toHaveBeenCalledOnce();
  });
});

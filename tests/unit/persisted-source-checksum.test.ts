import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { DatasetImportService } from "@/server/services/dataset-import-service";
import { datasetVersions, datasetFiles } from "@/server/database/schema/datasets";
import { datasetImports, datasetImportFiles } from "@/server/database/schema/dataset-imports";
import type { SubmitImportManifestInput } from "@/server/services/dataset-import-service";

interface Row {
  datasetFileId: string;
  organizationId: string;
  datasetVersionId: string;
  sourceFormat: string;
  fileName: string;
  byteSize: number;
  sha256: string;
  uploadSessionId: string;
  sessionStatus: string;
}
const mocks = vi.hoisted(() => ({ getDb: vi.fn(), getImportDb: vi.fn() }));
vi.mock("@/server/database/client", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/database/import-finalizer-client", () => ({
  getImportFinalizerDb: mocks.getImportDb,
}));

let rows: Row[];
let versionFormat: string;
let versionMissing: boolean;
let activeTransaction: boolean;
let committed: Array<{ table: unknown; value: unknown }>;
let selects: Array<{ table: unknown; sql: string; params: unknown[] }>;
let joins: string[];
let failMembership: boolean;
let returnUnexpectedRows: boolean;
const getDbCalls = () => mocks.getDb.mock.calls.length;

function submission(): SubmitImportManifestInput {
  return {
    context: { organizationId: "org_A", userId: "user_A", role: "scientist" },
    datasetVersionId: "dsv_A",
    sourceFormat: "GENERIC_MATRIX",
    files: [{ datasetFileId: "file_A", role: "MATRIX", ordinal: 0 }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  versionFormat = "GENERIC_MATRIX";
  versionMissing = false;
  activeTransaction = false;
  committed = [];
  selects = [];
  joins = [];
  failMembership = false;
  returnUnexpectedRows = false;
  rows = [
    {
      datasetFileId: "file_A",
      organizationId: "org_A",
      datasetVersionId: "dsv_A",
      sourceFormat: "GENERIC_MATRIX",
      fileName: "sample 01.tsv",
      byteSize: 42,
      sha256: "0".repeat(64),
      uploadSessionId: "session_A",
      sessionStatus: "VERIFIED",
    },
  ];
  const readDb = {
    select: vi.fn(() => {
      let table: unknown;
      const query = {
        from: (value: unknown) => {
          table = value;
          return query;
        },
        innerJoin: (_value: unknown, condition: SQL) => {
          joins.push(new PgDialect().sqlToQuery(condition).sql);
          return query;
        },
        where: async (condition: SQL) => {
          expect(activeTransaction).toBe(true);
          const sql = new PgDialect().sqlToQuery(condition);
          selects.push({ table, sql: sql.sql, params: sql.params });
          if (table === datasetVersions)
            return versionMissing ? [] : [{ sourceFormat: versionFormat }];
          // Simulated database WHERE; assertions below independently inspect the generated SQL.
          return returnUnexpectedRows
            ? rows
            : rows.filter((row) => sql.params.includes(row.datasetFileId));
        },
      };
      return query;
    }),
  };
  const writeDb = {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const pending: Array<{ table: unknown; value: unknown }> = [];
      activeTransaction = true;
      const tx = {
        insert: (table: unknown) => ({
          values: async (value: unknown) => {
            expect(activeTransaction).toBe(true);
            if (table === datasetImportFiles && failMembership)
              throw new Error("membership failure");
            pending.push({ table, value });
          },
        }),
      };
      try {
        const result = await callback(tx);
        committed.push(...pending);
        return result;
      } finally {
        activeTransaction = false;
      }
    }),
  };
  mocks.getDb.mockReturnValue(readDb);
  mocks.getImportDb.mockResolvedValue(writeDb);
});

describe("production persisted source checksum integration (database simulated)", () => {
  it.each(["H5AD", "TENX_H5", "GENERIC_MATRIX"] as const)(
    "persists format-specific %s checksum using production provider",
    async (sourceFormat) => {
      const input = submission();
      input.sourceFormat = sourceFormat;
      versionFormat = sourceFormat;
      rows[0]!.sourceFormat = sourceFormat;
      input.files[0]!.role = sourceFormat === "GENERIC_MATRIX" ? "MATRIX" : "PRIMARY";
      // This unrelated same-version file must never enter the source checksum.
      rows.push({
        ...rows[0]!,
        datasetFileId: "unrelated",
        fileName: "UNRELATED.tsv",
        sha256: "f".repeat(64),
      });
      const result = await new DatasetImportService().submitImportManifest(input);
      const expected =
        sourceFormat === "GENERIC_MATRIX"
          ? "3b31b99468b5cd88de2d8c62af677ef5b2603c1397ba83538b3d150424acb021"
          : "0".repeat(64);
      expect(result.sourceChecksum).toBe(expected);
      expect(committed[0]).toEqual({
        table: datasetImports,
        value: expect.objectContaining({
          sourceChecksum: expected,
          sourceFormat,
          organizationId: "org_A",
        }),
      });
      expect(committed[1]).toEqual({
        table: datasetImportFiles,
        value: [
          expect.objectContaining({
            datasetFileId: "file_A",
            organizationId: "org_A",
            datasetVersionId: "dsv_A",
          }),
        ],
      });
      expect(mocks.getImportDb).toHaveBeenCalledOnce();
      expect(getDbCalls()).toBe(1);
      const sourceQuery = selects.find((entry) => entry.table === datasetFiles);
      expect(sourceQuery?.params).toEqual(["file_A", "org_A", "dsv_A", "VERIFIED"]);
      expect(sourceQuery?.sql).toContain('"dataset_files"."organization_id"');
      expect(sourceQuery?.sql).toContain('"dataset_files"."dataset_version_id"');
      expect(sourceQuery?.sql).toContain('"dataset_files"."id" in');
      expect(joins.join("\n")).toContain('"dataset_file_provenance"."r2_key"');
      expect(joins.join("\n")).toContain('"upload_sessions"."organization_id"');
    }
  );

  it("persists TENX_MTX checksum from exact selected triplet", async () => {
    const input = submission();
    input.sourceFormat = "TENX_MTX";
    versionFormat = "TENX_MTX";
    rows = [
      {
        ...rows[0]!,
        datasetFileId: "m",
        sourceFormat: "TENX_MTX",
        fileName: "matrix.mtx.gz",
        uploadSessionId: "session_m",
        byteSize: 1024,
        sha256: "3".repeat(64),
      },
      {
        ...rows[0]!,
        datasetFileId: "b",
        sourceFormat: "TENX_MTX",
        fileName: "barcodes.tsv.gz",
        uploadSessionId: "session_b",
        byteSize: 256,
        sha256: "1".repeat(64),
      },
      {
        ...rows[0]!,
        datasetFileId: "f",
        sourceFormat: "TENX_MTX",
        fileName: "features.tsv.gz",
        uploadSessionId: "session_f",
        byteSize: 512,
        sha256: "2".repeat(64),
      },
    ];
    input.files = [
      { datasetFileId: "m", role: "MATRIX", ordinal: 0 },
      { datasetFileId: "f", role: "FEATURES", ordinal: 0 },
      { datasetFileId: "b", role: "BARCODES", ordinal: 0 },
    ];
    const result = await new DatasetImportService().submitImportManifest(input);
    expect(result.sourceChecksum).toBe(
      "69a76db537290feab98f01ef5bbefb3662aeed1d8376ea468079017c72e63e92"
    );
    expect(committed).toHaveLength(2);
  });

  it.each([
    { organizationId: "org_other" },
    { datasetVersionId: "dsv_other" },
    { sourceFormat: "H5AD" },
    { sessionStatus: "UPLOADED" },
    { sha256: "bad" },
    { fileName: "../unsafe" },
    { byteSize: -1 },
  ])("fails before persistence for unavailable/invalid source facts %j", async (change) => {
    rows[0] = { ...rows[0]!, ...change };
    await expect(new DatasetImportService().submitImportManifest(submission())).rejects.toThrow();
    expect(committed).toEqual([]);
  });

  it.each(["missing", "duplicate", "extra"])("rejects %s source resolution", async (kind) => {
    if (kind === "missing") rows = [];
    else if (kind === "duplicate") rows.push({ ...rows[0]! });
    else {
      returnUnexpectedRows = true;
      rows.push({ ...rows[0]!, datasetFileId: "extra" });
    }
    await expect(new DatasetImportService().submitImportManifest(submission())).rejects.toThrow(
      /unavailable/
    );
    expect(committed).toEqual([]);
  });

  it.each([
    "sourceChecksum",
    "fileName",
    "byteSize",
    "sha256",
    "organizationId",
    "r2Key",
    "uploadSessionId",
  ])("rejects caller authority field %s", async (field) => {
    const service = new DatasetImportService();
    await expect(
      Reflect.apply(service.submitImportManifest, service, [
        { ...submission(), [field]: "injected" },
      ])
    ).rejects.toThrow(/Invalid import/);
    expect(mocks.getImportDb).not.toHaveBeenCalled();
    expect(committed).toEqual([]);
  });

  it.each(["fileName", "byteSize", "sha256", "r2Key", "uploadSessionId", "sourceChecksum"])(
    "rejects injected source member fact %s",
    async (field) => {
      const input = submission();
      const service = new DatasetImportService();
      await expect(
        Reflect.apply(service.submitImportManifest, service, [
          {
            ...input,
            files: [{ ...input.files[0], [field]: "injected" }],
          },
        ])
      ).rejects.toThrow(/Invalid import/);
      expect(mocks.getImportDb).not.toHaveBeenCalled();
      expect(committed).toEqual([]);
    }
  );

  it("compatibility entry cannot accept a direct sourceChecksum override", async () => {
    const service = new DatasetImportService();
    await expect(
      Reflect.apply(service.createTrustedImportManifest, service, [
        { ...submission(), sourceChecksum: "f".repeat(64) },
      ])
    ).rejects.toThrow(/Invalid import/);
    expect(committed).toEqual([]);
  });

  it.each(["H5AD", "unknown"])(
    "rejects request/persisted source-format mismatch %s",
    async (format) => {
      versionFormat = format;
      await expect(new DatasetImportService().submitImportManifest(submission())).rejects.toThrow(
        /source format/
      );
      expect(selects).toHaveLength(1);
      expect(committed).toEqual([]);
    }
  );

  it("does not disclose another tenant's version", async () => {
    versionMissing = true;
    await expect(new DatasetImportService().submitImportManifest(submission())).rejects.toThrow(
      "Dataset version unavailable in active organization"
    );
    expect(committed).toEqual([]);
  });

  it("rolls back the root when membership insertion fails", async () => {
    failMembership = true;
    await expect(new DatasetImportService().submitImportManifest(submission())).rejects.toThrow(
      "membership failure"
    );
    expect(committed).toEqual([]);
  });

  it("snapshots candidate membership before asynchronous resolution", async () => {
    const input = submission();
    const pending = new DatasetImportService().submitImportManifest(input);
    input.files[0]!.datasetFileId = "injected";
    await pending;
    expect(committed[1]?.value).toEqual([expect.objectContaining({ datasetFileId: "file_A" })]);
  });

  it("keeps finalizer source-checksum derivation inside existing SQL", () => {
    const sql = readFileSync(
      "src/server/database/migrations/0004_phase3_import_persistence_and_security.sql",
      "utf8"
    );
    expect(sql).toContain("SELECT di.id, di.source_format, di.source_checksum");
    expect(sql).toContain("source_checksum = v_import_source_checksum");
    const finalizer = readFileSync(
      "src/server/services/published-dataset-import-finalization.ts",
      "utf8"
    );
    expect(finalizer).not.toContain("sourceChecksum");
  });

  it("uses metadata only, without storage/file transport", () => {
    for (const file of ["source-checksum.ts", "persisted-source-checksum-provider.ts"]) {
      const source = readFileSync(`src/server/services/${file}`, "utf8");
      expect(source).not.toMatch(
        /node:fs|@aws-sdk|r2-client|r2-storage|presigner|\bfetch\s*\(|getSignedUrl/
      );
      expect(source).not.toMatch(/localeCompare|\.toLowerCase\(/);
    }
  });
});

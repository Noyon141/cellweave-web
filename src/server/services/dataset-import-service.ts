import "server-only";
import { eq, and, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "@/types";
import { generateDomainId } from "@/lib/id";
import { getDb, type DbClient } from "../database/client";
import {
  datasetFileProvenance,
  datasetImports,
  datasetImportFiles,
} from "../database/schema/dataset-imports";
import { datasetVersions } from "../database/schema/datasets";
import { ConflictError, ResourceNotFoundError, ValidationError } from "../authorization/errors";

import { z } from "zod";
import { ORGANIZATION_ROLES } from "@/types";
import { getImportFinalizerDb } from "../database/import-finalizer-client";
import {
  PersistedSourceChecksumProvider,
  type TrustedChecksumProvider,
} from "./persisted-source-checksum-provider";
import {
  validateRoleCardinality,
  type ImportSourceFormat,
  type ImportFileRole,
} from "./source-import-policy";
export type { ImportSourceFormat, ImportFileRole } from "./source-import-policy";
export type {
  TrustedChecksumProvider,
  TrustedChecksumInput,
} from "./persisted-source-checksum-provider";

export interface DatasetFileProvenanceDTO {
  id: string;
  organizationId: string;
  datasetVersionId: string;
  datasetFileId: string;
  uploadSessionId: string;
  r2Key: string;
  sha256: string;
  compression: "NONE" | "GZIP";
  createdAt: Date;
}

export interface DatasetImportFileDTO {
  id: string;
  organizationId: string;
  datasetVersionId: string;
  importId: string;
  datasetFileId: string;
  role: ImportFileRole;
  ordinal: number;
  createdAt: Date;
}

export interface DatasetImportDTO {
  id: string;
  organizationId: string;
  datasetVersionId: string;
  sourceFormat: ImportSourceFormat;
  sourceChecksum: string;
  createdAt: Date;
  files: DatasetImportFileDTO[];
}

export interface RegisterFileProvenanceInput {
  context: TenantContext;
  datasetVersionId: string;
  datasetFileId: string;
  uploadSessionId: string;
  r2Key: string;
  sha256: string;
  compression: "NONE" | "GZIP";
}

export interface SubmitImportFileInput {
  datasetFileId: string;
  role: ImportFileRole;
  ordinal: number;
}

export type ImportFileInput = SubmitImportFileInput;

/**
 * Public application submission payload.
 * Invariant: Public requests CANNOT supply sourceChecksum, sha256,
 * byteSize, r2Key, or uploadSessionId.
 */
export interface SubmitImportManifestInput {
  context: TenantContext;
  datasetVersionId: string;
  sourceFormat: ImportSourceFormat;
  files: SubmitImportFileInput[];
}

/** Compatibility method name only; no caller-supplied checksum is accepted. */
export type CreateTrustedImportManifestInput = SubmitImportManifestInput;

export interface FinalizeImportInput {
  context: TenantContext;
  datasetVersionId: string;
  canonicalChecksum: string;
  organism: string;
  geneIdScheme: string;
  referenceBuild?: string | null;
  cellCount: number;
  geneCount: number;
  ipHash?: string | null;
  userAgent?: string | null;
  auditEventId?: string | null;
}

export interface FinalizeImportResult {
  status: "FINALIZED" | "ALREADY_FINALIZED";
  canonicalArtifactKey: string;
  finalizedAt: Date;
}

export interface DatasetImportServiceOptions {
  /** Explicit isolation seam for tests. Production construction supplies no testDependencies. */
  testDependencies?: { dbClient: DbClient; checksumProvider?: TrustedChecksumProvider };
}

const sourceFormatSchema = z.enum(["H5AD", "TENX_H5", "TENX_MTX", "GENERIC_MATRIX"]);
const submissionSchema = z
  .object({
    context: z
      .object({
        organizationId: z.string().min(1),
        userId: z.string().min(1),
        role: z.enum(ORGANIZATION_ROLES),
      })
      .strict(),
    datasetVersionId: z.string().min(1),
    sourceFormat: sourceFormatSchema,
    files: z
      .array(
        z
          .object({
            datasetFileId: z.string().min(1),
            role: z.enum([
              "PRIMARY",
              "MATRIX",
              "FEATURES",
              "BARCODES",
              "CELL_METADATA",
              "FEATURE_METADATA",
            ]),
            ordinal: z.number().int().nonnegative().max(2147483647),
          })
          .strict()
      )
      .min(1),
  })
  .strict();

const SHA256_REGEX = /^[0-9a-f]{64}$/;

/**
 * Dataset Import Application Service (Phase 3 Scientific Persistence Boundary)
 */
export class DatasetImportService {
  private readonly db: DbClient;
  private readonly checksumProvider: TrustedChecksumProvider;
  private readonly getImportDb: () => Promise<DbClient>;

  constructor(options: DatasetImportServiceOptions = {}) {
    this.db = options.testDependencies?.dbClient ?? getDb();
    this.checksumProvider =
      options.testDependencies?.checksumProvider ?? new PersistedSourceChecksumProvider(this.db);
    const testDb = options.testDependencies?.dbClient;
    this.getImportDb = testDb ? async () => testDb : getImportFinalizerDb;
  }

  /**
   * Registers verified physical file provenance.
   */
  async registerFileProvenance(
    input: RegisterFileProvenanceInput
  ): Promise<DatasetFileProvenanceDTO> {
    const orgId = input.context.organizationId;

    if (input.sha256.length !== 64 || !SHA256_REGEX.test(input.sha256)) {
      throw new ValidationError("sha256 must be a 64-character lowercase hex string");
    }

    if (input.compression !== "NONE" && input.compression !== "GZIP") {
      throw new ValidationError("compression must be either NONE or GZIP");
    }

    const id = generateDomainId("dfp");
    const record = {
      id,
      organizationId: orgId,
      datasetVersionId: input.datasetVersionId,
      datasetFileId: input.datasetFileId,
      uploadSessionId: input.uploadSessionId,
      r2Key: input.r2Key,
      sha256: input.sha256,
      compression: input.compression,
    };

    const importDb = await this.getImportDb();
    await importDb.insert(datasetFileProvenance).values(record);

    return {
      ...record,
      createdAt: new Date(),
    };
  }

  /**
   * Public manifest submission boundary.
   * Does NOT accept sourceChecksum, sha256, r2Key, or uploadSessionId from caller.
   * Looks up physical provenance from database and resolves checksum via TrustedChecksumProvider.
   */
  async submitImportManifest(input: SubmitImportManifestInput): Promise<DatasetImportDTO> {
    // Snapshot and validate before any await: no checksum/fact overrides or mutable membership.
    const parsed = submissionSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError("Invalid import manifest submission");
    const candidate = parsed.data;
    validateRoleCardinality(candidate.sourceFormat, candidate.files);
    const orgId = candidate.context.organizationId;
    const importDb = await this.getImportDb();

    return importDb.transaction(async (tx) => {
      // Ordinary runtime reads; import writer has no need for broad source-table privileges.
      const [versionRecord] = await this.db
        .select()
        .from(datasetVersions)
        .where(
          and(
            eq(datasetVersions.id, candidate.datasetVersionId),
            eq(datasetVersions.organizationId, orgId)
          )
        );
      if (!versionRecord)
        throw new ResourceNotFoundError("Dataset version unavailable in active organization");
      const format = sourceFormatSchema.safeParse(versionRecord.sourceFormat);
      if (!format.success || format.data !== candidate.sourceFormat) {
        throw new ValidationError("Import source format does not match persisted dataset version");
      }
      const sourceChecksum = await this.checksumProvider.computeSourceChecksum({
        context: candidate.context,
        datasetVersionId: candidate.datasetVersionId,
        sourceFormat: format.data,
        files: candidate.files,
      });
      if (
        typeof sourceChecksum !== "string" ||
        sourceChecksum.length !== 64 ||
        !SHA256_REGEX.test(sourceChecksum)
      ) {
        throw new ValidationError("Invalid trusted source checksum result");
      }
      const importRecord = {
        id: generateDomainId("dim"),
        organizationId: orgId,
        datasetVersionId: candidate.datasetVersionId,
        sourceFormat: format.data,
        sourceChecksum,
      };
      await tx.insert(datasetImports).values(importRecord);
      const fileRecords: DatasetImportFileDTO[] = candidate.files.map((file) => ({
        id: generateDomainId("dif"),
        organizationId: orgId,
        datasetVersionId: candidate.datasetVersionId,
        importId: importRecord.id,
        datasetFileId: file.datasetFileId,
        role: file.role,
        ordinal: file.ordinal,
        createdAt: new Date(),
      }));
      await tx.insert(datasetImportFiles).values(fileRecords);
      return { ...importRecord, createdAt: new Date(), files: fileRecords };
    });
  }

  /** Compatibility entry point delegates to the same computed-checksum authority. */
  async createTrustedImportManifest(
    input: CreateTrustedImportManifestInput
  ): Promise<DatasetImportDTO> {
    return this.submitImportManifest(input);
  }

  /**
   * Retrieves an import manifest by dataset version.
   */
  async getImportManifest(
    context: TenantContext,
    datasetVersionId: string
  ): Promise<DatasetImportDTO | null> {
    const orgId = context.organizationId;

    const [manifest] = await this.db
      .select()
      .from(datasetImports)
      .where(
        and(
          eq(datasetImports.datasetVersionId, datasetVersionId),
          eq(datasetImports.organizationId, orgId)
        )
      );

    if (!manifest) {
      return null;
    }

    const files = await this.db
      .select()
      .from(datasetImportFiles)
      .where(
        and(
          eq(datasetImportFiles.importId, manifest.id),
          eq(datasetImportFiles.organizationId, orgId)
        )
      );

    return {
      id: manifest.id,
      organizationId: manifest.organizationId,
      datasetVersionId: manifest.datasetVersionId,
      sourceFormat: manifest.sourceFormat as ImportSourceFormat,
      sourceChecksum: manifest.sourceChecksum,
      createdAt: manifest.createdAt,
      files: files.map((f) => ({
        id: f.id,
        organizationId: f.organizationId,
        datasetVersionId: f.datasetVersionId,
        importId: f.importId,
        datasetFileId: f.datasetFileId,
        role: f.role as ImportFileRole,
        ordinal: f.ordinal,
        createdAt: f.createdAt,
      })),
    };
  }

  /**
   * Finalizes dataset version import through the privileged stored procedure.
   */
  async finalizeImport(input: FinalizeImportInput): Promise<FinalizeImportResult> {
    const orgId = input.context.organizationId;
    const actorType = "user";
    const actorId = input.context.userId;

    if (!SHA256_REGEX.test(input.canonicalChecksum)) {
      throw new ValidationError("canonicalChecksum must be a 64-character lowercase hex string");
    }

    if (input.cellCount < 1 || input.geneCount < 1) {
      throw new ValidationError("cellCount and geneCount must be at least 1");
    }

    const auditEventId = input.auditEventId ?? `aud_${randomUUID()}`;

    try {
      const result = await this.db.execute<{
        status: string;
        canonical_artifact_key: string;
        finalized_at: string | Date;
      }>(
        sql`SELECT * FROM finalize_dataset_version_import(
          ${orgId},
          ${input.datasetVersionId},
          ${input.canonicalChecksum},
          ${input.organism},
          ${input.geneIdScheme},
          ${input.referenceBuild ?? null},
          ${input.cellCount},
          ${input.geneCount},
          ${actorType},
          ${actorId},
          ${input.ipHash ?? null},
          ${input.userAgent ?? null},
          ${auditEventId}
        )`
      );

      const row = result.rows?.[0];
      if (!row) {
        throw new ConflictError("Finalization produced no response from database");
      }

      return {
        status: row.status as "FINALIZED" | "ALREADY_FINALIZED",
        canonicalArtifactKey: row.canonical_artifact_key,
        finalizedAt: new Date(row.finalized_at),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes("DATASET_VERSION_NOT_FOUND")) {
        throw new ResourceNotFoundError(
          `Dataset version ${input.datasetVersionId} not found in active organization`
        );
      }
      if (
        message.includes("FINALIZATION_CONFLICT") ||
        message.includes("CONCURRENT_FINALIZATION_CONFLICT") ||
        message.includes("UPLOAD_SESSION_STATE_CONFLICT")
      ) {
        throw new ConflictError(message);
      }
      if (
        message.includes("INVALID_ARGUMENT") ||
        message.includes("INVALID_CHECKSUM") ||
        message.includes("INVALID_COUNTS") ||
        message.includes("CARDINALITY_ERROR") ||
        message.includes("INCOMPLETE_PROVENANCE") ||
        message.includes("SOURCE_FORMAT_MISMATCH") ||
        message.includes("IMPORT_MANIFEST_NOT_FOUND") ||
        message.includes("IMPORT_EMPTY")
      ) {
        throw new ValidationError(message);
      }

      throw err;
    }
  }
}

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

export type ImportSourceFormat = "H5AD" | "TENX_H5" | "TENX_MTX" | "GENERIC_MATRIX";

export type ImportFileRole =
  "PRIMARY" | "MATRIX" | "FEATURES" | "BARCODES" | "CELL_METADATA" | "FEATURE_METADATA";

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

export interface ProvenanceFileDetail {
  datasetFileId: string;
  role: ImportFileRole;
  ordinal: number;
  sha256: string;
  compression: "NONE" | "GZIP";
}

/**
 * Seam for computing authoritative composite sourceChecksum.
 * Web NEVER implements independent production hashing algorithms.
 * In Step C, an injected fixture provider is used for tests.
 * In Step D, this interface connects to the scientific engine primitive.
 */
export interface TrustedChecksumProvider {
  computeSourceChecksum(
    sourceFormat: ImportSourceFormat,
    files: ProvenanceFileDetail[]
  ): Promise<string> | string;
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

export interface CreateTrustedImportManifestInput {
  context: TenantContext;
  datasetVersionId: string;
  sourceFormat: ImportSourceFormat;
  sourceChecksum: string;
  files: SubmitImportFileInput[];
}

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
  dbClient?: DbClient;
  checksumProvider?: TrustedChecksumProvider;
}

const SHA256_REGEX = /^[0-9a-f]{64}$/;

/**
 * Validates role distribution and exact cardinality for all supported source formats.
 */
function validateRoleCardinality(
  sourceFormat: ImportSourceFormat,
  files: SubmitImportFileInput[]
): void {
  if (!files || files.length === 0) {
    throw new ValidationError("Import manifest must contain at least one file");
  }

  // Duplicate file ID guard
  const fileIds = new Set<string>();
  for (const f of files) {
    if (fileIds.has(f.datasetFileId)) {
      throw new ValidationError(`Duplicate file ${f.datasetFileId} in import manifest`);
    }
    fileIds.add(f.datasetFileId);
  }

  const roleCounts: Record<ImportFileRole, number> = {
    PRIMARY: 0,
    MATRIX: 0,
    FEATURES: 0,
    BARCODES: 0,
    CELL_METADATA: 0,
    FEATURE_METADATA: 0,
  };

  for (const f of files) {
    if (!(f.role in roleCounts)) {
      throw new ValidationError(`Invalid file role ${f.role} in manifest`);
    }
    roleCounts[f.role]++;
  }

  if (sourceFormat === "H5AD") {
    if (roleCounts.PRIMARY !== 1 || files.length !== 1) {
      throw new ValidationError("H5AD import requires exactly 1 file with role PRIMARY");
    }
  } else if (sourceFormat === "TENX_H5") {
    if (roleCounts.PRIMARY !== 1 || files.length !== 1) {
      throw new ValidationError("TENX_H5 import requires exactly 1 file with role PRIMARY");
    }
  } else if (sourceFormat === "TENX_MTX") {
    if (
      roleCounts.MATRIX !== 1 ||
      roleCounts.FEATURES !== 1 ||
      roleCounts.BARCODES !== 1 ||
      files.length !== 3
    ) {
      throw new ValidationError(
        "TENX_MTX import requires exactly 3 files: MATRIX, FEATURES, and BARCODES"
      );
    }
  } else if (sourceFormat === "GENERIC_MATRIX") {
    const invalidRoles = roleCounts.PRIMARY + roleCounts.FEATURES + roleCounts.BARCODES;
    if (
      roleCounts.MATRIX !== 1 ||
      roleCounts.CELL_METADATA > 1 ||
      roleCounts.FEATURE_METADATA > 1 ||
      invalidRoles > 0 ||
      files.length !== roleCounts.MATRIX + roleCounts.CELL_METADATA + roleCounts.FEATURE_METADATA
    ) {
      throw new ValidationError(
        "GENERIC_MATRIX import requires exactly 1 MATRIX file, at most 1 CELL_METADATA, at most 1 FEATURE_METADATA, and no other roles"
      );
    }
  } else {
    throw new ValidationError(`Unsupported source format: ${sourceFormat}`);
  }
}

/**
 * Dataset Import Application Service (Phase 3 Scientific Persistence Boundary)
 */
export class DatasetImportService {
  private readonly db: DbClient;
  private readonly checksumProvider?: TrustedChecksumProvider;

  constructor(options: DatasetImportServiceOptions = {}) {
    this.db = options.dbClient ?? getDb();
    this.checksumProvider = options.checksumProvider;
  }

  /**
   * Registers verified physical file provenance.
   */
  async registerFileProvenance(
    input: RegisterFileProvenanceInput
  ): Promise<DatasetFileProvenanceDTO> {
    const orgId = input.context.organizationId;

    if (!SHA256_REGEX.test(input.sha256)) {
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

    await this.db.insert(datasetFileProvenance).values(record);

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
    const orgId = input.context.organizationId;

    // Strict role cardinality validation
    validateRoleCardinality(input.sourceFormat, input.files);

    // Look up verified physical provenance for each file
    const fileDetails: ProvenanceFileDetail[] = [];

    for (const f of input.files) {
      const [provenanceRow] = await this.db
        .select()
        .from(datasetFileProvenance)
        .where(
          and(
            eq(datasetFileProvenance.datasetFileId, f.datasetFileId),
            eq(datasetFileProvenance.organizationId, orgId),
            eq(datasetFileProvenance.datasetVersionId, input.datasetVersionId)
          )
        );

      if (!provenanceRow) {
        throw new ValidationError(
          `Missing verified physical provenance for file ${f.datasetFileId}`
        );
      }

      fileDetails.push({
        datasetFileId: f.datasetFileId,
        role: f.role,
        ordinal: f.ordinal,
        sha256: provenanceRow.sha256,
        compression: provenanceRow.compression as "NONE" | "GZIP",
      });
    }

    if (!this.checksumProvider) {
      throw new ValidationError(
        "Trusted checksum provider is not configured for manifest creation"
      );
    }

    const sourceChecksum = await this.checksumProvider.computeSourceChecksum(
      input.sourceFormat,
      fileDetails
    );

    return this.createTrustedImportManifest({
      context: input.context,
      datasetVersionId: input.datasetVersionId,
      sourceFormat: input.sourceFormat,
      sourceChecksum,
      files: input.files,
    });
  }

  /**
   * Trusted import manifest creation path (used by submitImportManifest or trusted service).
   */
  async createTrustedImportManifest(
    input: CreateTrustedImportManifestInput
  ): Promise<DatasetImportDTO> {
    const orgId = input.context.organizationId;

    if (!SHA256_REGEX.test(input.sourceChecksum)) {
      throw new ValidationError("sourceChecksum must be a 64-character lowercase hex string");
    }

    validateRoleCardinality(input.sourceFormat, input.files);

    const importId = generateDomainId("dim");

    return await this.db.transaction(async (tx) => {
      // Verify version exists and belongs to this org
      const [versionRecord] = await tx
        .select()
        .from(datasetVersions)
        .where(
          and(
            eq(datasetVersions.id, input.datasetVersionId),
            eq(datasetVersions.organizationId, orgId)
          )
        );

      if (!versionRecord) {
        throw new ResourceNotFoundError(
          `Dataset version ${input.datasetVersionId} not found in active organization`
        );
      }

      if (versionRecord.sourceFormat !== input.sourceFormat) {
        throw new ValidationError(
          `Dataset version source format ${versionRecord.sourceFormat} does not match import manifest format ${input.sourceFormat}`
        );
      }

      const importRecord = {
        id: importId,
        organizationId: orgId,
        datasetVersionId: input.datasetVersionId,
        sourceFormat: input.sourceFormat,
        sourceChecksum: input.sourceChecksum,
      };

      await tx.insert(datasetImports).values(importRecord);

      const fileRecords: DatasetImportFileDTO[] = input.files.map((file) => ({
        id: generateDomainId("dif"),
        organizationId: orgId,
        datasetVersionId: input.datasetVersionId,
        importId,
        datasetFileId: file.datasetFileId,
        role: file.role,
        ordinal: file.ordinal,
        createdAt: new Date(),
      }));

      await tx.insert(datasetImportFiles).values(fileRecords);

      return {
        ...importRecord,
        createdAt: new Date(),
        files: fileRecords,
      };
    });
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

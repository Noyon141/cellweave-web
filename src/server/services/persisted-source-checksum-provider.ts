import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { TenantContext } from "@/types";
import type { DbClient } from "../database/client";
import { datasetFiles, datasetVersions } from "../database/schema/datasets";
import { datasetFileProvenance } from "../database/schema/dataset-imports";
import { uploadSessions } from "../database/schema/upload-sessions";
import { ValidationError } from "../authorization/errors";
import { computeTrustedSourceChecksum } from "./source-checksum";
import {
  validateRoleCardinality,
  type ImportSourceFormat,
  type SourceImportMember,
} from "./source-import-policy";

export interface TrustedChecksumInput {
  context: TenantContext;
  datasetVersionId: string;
  /** Validated against tenant-scoped dataset_versions.source_format before calling. */
  sourceFormat: ImportSourceFormat;
  files: readonly SourceImportMember[];
}

export interface TrustedChecksumProvider {
  computeSourceChecksum(input: TrustedChecksumInput): Promise<string> | string;
}

const rowsSchema = z.array(
  z.object({
    datasetFileId: z.string(),
    organizationId: z.string(),
    datasetVersionId: z.string(),
    sourceFormat: z.string(),
    fileName: z.string(),
    byteSize: z.number(),
    sha256: z.string(),
    uploadSessionId: z.string().min(1),
    sessionStatus: z.literal("VERIFIED"),
  })
);

/** One tenant-scoped SELECT snapshot of immutable, exact selected source facts. */
export class PersistedSourceChecksumProvider implements TrustedChecksumProvider {
  constructor(private readonly db: Pick<DbClient, "select">) {}

  async computeSourceChecksum(input: TrustedChecksumInput): Promise<string> {
    validateRoleCardinality(input.sourceFormat, input.files);
    const ids = input.files.map((file) => file.datasetFileId);
    const rows = await this.db
      .select({
        datasetFileId: datasetFiles.id,
        organizationId: datasetFiles.organizationId,
        datasetVersionId: datasetFiles.datasetVersionId,
        sourceFormat: datasetVersions.sourceFormat,
        fileName: datasetFiles.fileName,
        byteSize: datasetFiles.byteSize,
        sha256: datasetFileProvenance.sha256,
        uploadSessionId: datasetFileProvenance.uploadSessionId,
        sessionStatus: uploadSessions.status,
      })
      .from(datasetFiles)
      .innerJoin(
        datasetVersions,
        and(
          eq(datasetVersions.id, datasetFiles.datasetVersionId),
          eq(datasetVersions.organizationId, datasetFiles.organizationId)
        )
      )
      .innerJoin(
        datasetFileProvenance,
        and(
          eq(datasetFileProvenance.datasetFileId, datasetFiles.id),
          eq(datasetFileProvenance.organizationId, datasetFiles.organizationId),
          eq(datasetFileProvenance.datasetVersionId, datasetFiles.datasetVersionId),
          eq(datasetFileProvenance.r2Key, datasetFiles.r2Key)
        )
      )
      .innerJoin(
        uploadSessions,
        and(
          eq(uploadSessions.id, datasetFileProvenance.uploadSessionId),
          eq(uploadSessions.organizationId, datasetFileProvenance.organizationId),
          eq(uploadSessions.datasetVersionId, datasetFileProvenance.datasetVersionId),
          eq(uploadSessions.r2Key, datasetFileProvenance.r2Key)
        )
      )
      .where(
        and(
          inArray(datasetFiles.id, ids),
          eq(datasetFiles.organizationId, input.context.organizationId),
          eq(datasetFiles.datasetVersionId, input.datasetVersionId),
          eq(uploadSessions.status, "VERIFIED")
        )
      );

    const parsed = rowsSchema.safeParse(rows);
    const unavailable = () =>
      new ValidationError("Import source members unavailable in active dataset version");
    if (!parsed.success || parsed.data.length !== ids.length) throw unavailable();
    const byId = new Map(parsed.data.map((row) => [row.datasetFileId, row]));
    if (
      byId.size !== ids.length ||
      parsed.data.some(
        (row) =>
          !ids.includes(row.datasetFileId) ||
          row.organizationId !== input.context.organizationId ||
          row.datasetVersionId !== input.datasetVersionId ||
          row.sourceFormat !== input.sourceFormat
      )
    ) {
      throw unavailable();
    }
    const files = input.files.map((member) => {
      const row = byId.get(member.datasetFileId);
      if (!row) throw unavailable();
      return { ...member, fileName: row.fileName, byteSize: row.byteSize, sha256: row.sha256 };
    });
    return computeTrustedSourceChecksum({ sourceFormat: input.sourceFormat, files }).sourceChecksum;
  }
}

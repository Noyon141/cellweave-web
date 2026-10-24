import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { CanonicalArtifactPublicationResult, TenantContext } from "@/types";
import { ORGANIZATION_ROLES } from "@/types";
import { generateDomainId } from "@/lib/id";
import type { RequestAuditMetadata } from "../api/request-metadata";
import { getImportFinalizerDb } from "../database/import-finalizer-client";
import { hashIpAddress } from "./audit-privacy";
import {
  DatasetImportFinalizationError,
  DatasetImportFinalizationConflictError,
  DatasetImportFinalizationSecurityError,
  DatasetImportFinalizationDatabaseError,
} from "./dataset-import-finalization-errors";

const nonblank = z.string().refine((value) => value.trim().length > 0);
const publicationSchema: z.ZodType<CanonicalArtifactPublicationResult> = z
  .object({
    datasetVersionId: nonblank,
    canonicalChecksum: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/),
    byteSize: z.number().int().nonnegative().safe(),
    status: z.enum(["PUBLISHED", "ALREADY_PRESENT"]),
  })
  .strict();

const inputSchema = z
  .object({
    context: z
      .object({
        organizationId: nonblank,
        userId: nonblank,
        role: z.enum(ORGANIZATION_ROLES),
      })
      .strict(),
    datasetVersionId: nonblank,
    publicationResult: publicationSchema,
    scientificFacts: z
      .object({
        organism: nonblank,
        geneIdScheme: nonblank,
        referenceBuild: z.string().nullable(),
        cellCount: z.number().int().positive().max(2147483647),
        geneCount: z.number().int().positive().max(2147483647),
      })
      .strict(),
    auditMetadata: z
      .object({
        clientIp: z.string().nullable(),
        userAgent: z.string().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface FinalizePublishedDatasetImportInput {
  /** Already server-validated; this internal service does not authenticate browser requests. */
  context: TenantContext;
  datasetVersionId: string;
  publicationResult: CanonicalArtifactPublicationResult;
  /** From trusted scientific canonicalization, never inferred by web. */
  scientificFacts: {
    organism: string;
    geneIdScheme: string;
    referenceBuild: string | null;
    cellCount: number;
    geneCount: number;
  };
  /** Already extracted through trusted request metadata helpers, if applicable. */
  auditMetadata?: RequestAuditMetadata;
}

export interface PublishedDatasetImportFinalizationResult {
  datasetVersionId: string;
  canonicalChecksum: string;
  status: "FINALIZED" | "ALREADY_FINALIZED";
  finalizedAt: Date;
}

const resultSchema = z.object({
  status: z.enum(["FINALIZED", "ALREADY_FINALIZED"]),
  canonical_artifact_key: nonblank,
  finalized_at: z
    .union([z.string(), z.date()])
    .transform((value) => new Date(value))
    .refine((value) => Number.isFinite(value.getTime())),
});

function classifyDatabaseError(error: unknown): DatasetImportFinalizationError {
  // Drizzle can wrap the PostgreSQL error in cause. Never propagate either message.
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (
      /^(FINALIZATION_CONFLICT|CONCURRENT_FINALIZATION_CONFLICT|UPLOAD_SESSION_STATE_CONFLICT|SOURCE_FORMAT_MISMATCH):/.test(
        current.message
      )
    ) {
      return new DatasetImportFinalizationConflictError();
    }
    if (current.message.startsWith("DATASET_VERSION_NOT_FOUND:")) {
      return new DatasetImportFinalizationSecurityError();
    }
    current = current.cause;
  }
  return new DatasetImportFinalizationDatabaseError();
}

/** Internal only: consumes H.2 proof; PostgreSQL owns all transitions and auditing. */
export async function finalizePublishedDatasetImport(
  input: FinalizePublishedDatasetImportInput
): Promise<PublishedDatasetImportFinalizationResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DatasetImportFinalizationError("Invalid trusted import finalization input");
  }
  const { context, datasetVersionId, publicationResult, scientificFacts, auditMetadata } =
    parsed.data;
  if (publicationResult.datasetVersionId !== datasetVersionId) {
    throw new DatasetImportFinalizationSecurityError();
  }

  const ipHash = hashIpAddress(auditMetadata?.clientIp);
  const userAgent = auditMetadata?.userAgent?.trim() || null;
  const auditEventId = generateDomainId("aud");
  // Resolve only after all input validation. No ordinary runtime connection is used.
  const db = await getImportFinalizerDb();
  let rows: unknown;
  try {
    const result = await db.execute(sql`SELECT * FROM public.finalize_dataset_version_import(
      ${context.organizationId},
      ${datasetVersionId},
      ${publicationResult.canonicalChecksum},
      ${scientificFacts.organism},
      ${scientificFacts.geneIdScheme},
      ${scientificFacts.referenceBuild},
      ${scientificFacts.cellCount},
      ${scientificFacts.geneCount},
      ${"user"},
      ${context.userId},
      ${ipHash},
      ${userAgent},
      ${auditEventId}
    )`);
    rows = result.rows;
  } catch (error: unknown) {
    throw classifyDatabaseError(error);
  }
  const response = z.array(resultSchema).length(1).safeParse(rows);
  const row = response.success ? response.data[0] : undefined;
  if (!row) {
    throw new DatasetImportFinalizationDatabaseError();
  }
  return {
    datasetVersionId,
    canonicalChecksum: publicationResult.canonicalChecksum,
    status: row.status,
    finalizedAt: row.finalized_at,
  };
}

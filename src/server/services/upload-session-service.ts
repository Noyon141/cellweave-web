import { eq, and, inArray } from "drizzle-orm";
import { z } from "zod";
import type { TenantContext, UploadState } from "@/types";
import { generateDomainId } from "@/lib/id";
import { getDb, type DbClient } from "../database/client";
import { uploadSessions } from "../database/schema/upload-sessions";
import { datasets, datasetVersions, datasetFiles } from "../database/schema/datasets";
import { projects } from "../database/schema/projects";
import {
  ConflictError,
  ResourceNotFoundError,
  TenantAuthorizationError,
  ValidationError,
  IntegrityError,
} from "../authorization/errors";
import { AuditService } from "./audit-service";
import { ProjectPermissionService } from "./project-permission-service";
import {
  type StorageService,
  StorageError,
  S3_PROTOCOL_LIMITS,
  STORAGE_DEFAULTS,
} from "../integrations/storage/storage-types";
import { getR2StorageService } from "../integrations/storage/r2-storage-service";
import {
  buildDatasetSourceObjectKey,
  normalizeSafeFileName,
} from "../integrations/storage/object-key";

// ============================================================================
// 1. DATA TRANSFER OBJECTS & INTERFACES
// ============================================================================

export interface UploadSessionDTO {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly datasetVersionId: string;
  readonly r2Key: string;
  readonly r2UploadId: string;
  readonly status: UploadState;
  readonly expectedSize: number;
  readonly partSize: number;
  readonly totalParts: number;
  readonly expiresAt: Date;
  readonly failureCode: string | null;
  readonly failureSummary: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UploadPartUrlDTO {
  readonly partNumber: number;
  readonly presignedUrl: string;
  readonly expiresInSeconds: number;
}

export interface ResumeStateDTO {
  readonly sessionId: string;
  readonly status: UploadState;
  readonly totalParts: number;
  readonly partSize: number;
  readonly expectedSize: number;
  readonly uploadedParts: readonly {
    readonly partNumber: number;
    readonly eTag: string;
    readonly sizeBytes?: number;
  }[];
  readonly missingParts: readonly number[];
}

export interface DatasetFileDTO {
  readonly id: string;
  readonly organizationId: string;
  readonly datasetVersionId: string;
  readonly r2Key: string;
  readonly byteSize: number;
  readonly fileName: string;
  readonly contentType: string;
  readonly eTag: string;
  readonly createdAt: Date;
}

export interface CompleteUploadResultDTO {
  readonly session: UploadSessionDTO;
  readonly file: DatasetFileDTO;
}

// ============================================================================
// 2. INPUT SCHEMAS & VALIDATION
// ============================================================================

export const initiateUploadSchema = z.object({
  datasetVersionId: z.string().trim().min(1, "datasetVersionId is required"),
  fileName: z.string().trim().min(1, "fileName is required"),
  expectedSize: z
    .number()
    .int("expectedSize must be an integer")
    .positive("expectedSize must be a positive integer"),
  contentType: z.string().trim().min(1, "contentType is required"),
  partSize: z
    .number()
    .int("partSize must be an integer")
    .positive("partSize must be positive")
    .optional(),
});

export type InitiateUploadInput = z.infer<typeof initiateUploadSchema>;

export const createPartUploadUrlsSchema = z.object({
  sessionId: z.string().trim().min(1, "sessionId is required"),
  partNumbers: z
    .array(z.number().int().positive("partNumber must be a positive integer"))
    .min(1, "At least one partNumber is required"),
});

export type CreatePartUploadUrlsInput = z.infer<typeof createPartUploadUrlsSchema>;

export interface UploadSessionServiceOptions {
  readonly dbClient?: DbClient;
  readonly storageService?: StorageService;
  readonly auditService?: AuditService;
  readonly permissionService?: ProjectPermissionService;
  readonly sessionTtlMs?: number;
}

// ============================================================================
// 3. PART SIZING ALGORITHM (System Design §122)
// ============================================================================

export interface PartPlan {
  readonly partSize: number;
  readonly totalParts: number;
}

const DEFAULT_PART_SIZE = 10 * 1024 * 1024; // 10 MiB default part size
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours default TTL

/**
 * Calculates a protocol-compliant part size and total parts plan.
 * Enforces S3/R2 constraints: 5 MiB minimum part size (except final part),
 * 5 GiB maximum part size, 10,000 maximum parts, and 5 TiB maximum object size.
 */
export function calculatePartPlan(expectedSize: number, requestedPartSize?: number): PartPlan {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new ValidationError("expectedSize must be a positive integer");
  }
  if (expectedSize > S3_PROTOCOL_LIMITS.MAX_OBJECT_SIZE_BYTES) {
    throw new ValidationError(
      `expectedSize exceeds maximum object size of ${S3_PROTOCOL_LIMITS.MAX_OBJECT_SIZE_BYTES} bytes (5 TiB)`
    );
  }

  let partSize = requestedPartSize ?? DEFAULT_PART_SIZE;

  if (requestedPartSize !== undefined) {
    if (
      !Number.isSafeInteger(requestedPartSize) ||
      requestedPartSize < S3_PROTOCOL_LIMITS.MIN_PART_SIZE_BYTES
    ) {
      throw new ValidationError(
        `partSize must be at least ${S3_PROTOCOL_LIMITS.MIN_PART_SIZE_BYTES} bytes (5 MiB)`
      );
    }
    if (requestedPartSize > S3_PROTOCOL_LIMITS.MAX_PART_SIZE_BYTES) {
      throw new ValidationError(
        `partSize cannot exceed ${S3_PROTOCOL_LIMITS.MAX_PART_SIZE_BYTES} bytes (5 GiB)`
      );
    }
  }

  let totalParts = Math.ceil(expectedSize / partSize);

  // If totalParts exceeds 10,000, scale up partSize to satisfy S3 limits
  if (totalParts > S3_PROTOCOL_LIMITS.MAX_PARTS) {
    if (requestedPartSize !== undefined) {
      throw new ValidationError(
        `Requested partSize ${requestedPartSize} would result in ${totalParts} parts, exceeding maximum limit of ${S3_PROTOCOL_LIMITS.MAX_PARTS}`
      );
    }
    const minRequired = Math.ceil(expectedSize / S3_PROTOCOL_LIMITS.MAX_PARTS);
    const unit = S3_PROTOCOL_LIMITS.MIN_PART_SIZE_BYTES;
    partSize = Math.ceil(minRequired / unit) * unit;
    totalParts = Math.ceil(expectedSize / partSize);
  }

  return { partSize, totalParts };
}

// ============================================================================
// 4. UPLOAD SESSION SERVICE IMPLEMENTATION
// ============================================================================

/**
 * Resumable Multipart Upload Session Application Service (Phase 2 Foundation)
 *
 * Core Tenancy & Master Design Invariants:
 * 1. Strict Tenant Scoping: Every query and mutation is filtered by context.organizationId.
 * 2. Role Authorization:
 *    - Upload mutations require role in [owner, admin, bioinformatician, scientist].
 *    - Viewer role is strictly read-only and prohibited from initiating, uploading, or completing.
 * 3. Canonical Lifecycle State Machine:
 *    - CREATED -> UPLOADING -> UPLOADED -> VERIFYING -> VERIFIED.
 *    - Conditional updates enforce state transitions and prevent skipping UPLOADED or VERIFYING.
 * 4. Authoritative State:
 *    - R2 ListParts is the single source of truth for uploaded parts. No uploadedParts JSONB in DB.
 * 5. Compensating Actions & Reconciliation:
 *    - Initiation failure after R2 multipart creation triggers best-effort abortMultipartUpload.
 *    - Completion failure after R2 CompleteMultipartUpload leaves session in recoverable VERIFYING state.
 *    - NoSuchUpload during resume/completion reconciles via headObject.
 *    - Abort during VERIFYING or NoSuchUpload verifies headObject before aborting.
 * 6. Data Privacy & Zero-Proxy:
 *    - Large scientific file bytes NEVER flow through Next.js or Vercel.
 *    - Clients upload directly to Cloudflare R2 using short-lived presigned URLs.
 * 7. Audit Logging Idempotency:
 *    - Records upload.initiated, upload.completed, and upload.aborted.
 *    - Exactly one upload.completed audit event is produced upon initial VERIFIED transition.
 */
export class UploadSessionService {
  private readonly db: DbClient;
  private readonly storageService: StorageService;
  private readonly auditService: AuditService;
  private readonly permissionService: ProjectPermissionService;
  private readonly sessionTtlMs: number;

  constructor(options: UploadSessionServiceOptions = {}) {
    this.db = options.dbClient ?? getDb();
    this.storageService = options.storageService ?? getR2StorageService();
    this.auditService = options.auditService ?? new AuditService({ dbClient: this.db });
    this.permissionService =
      options.permissionService ??
      new ProjectPermissionService({ dbClient: this.db, auditService: this.auditService });
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  private assertCanMutate(context: TenantContext): void {
    if (context.role === "viewer") {
      throw new TenantAuthorizationError("Viewer role is not authorized to modify uploads");
    }
  }

  private mapSessionRow(row: typeof uploadSessions.$inferSelect): UploadSessionDTO {
    return {
      id: row.id,
      organizationId: row.organizationId,
      projectId: row.projectId,
      datasetVersionId: row.datasetVersionId,
      r2Key: row.r2Key,
      r2UploadId: row.r2UploadId,
      status: row.status as UploadState,
      expectedSize: row.expectedSize,
      partSize: row.partSize,
      totalParts: row.totalParts,
      expiresAt: row.expiresAt,
      failureCode: row.failureCode,
      failureSummary: row.failureSummary,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async markSessionFailed(
    organizationId: string,
    sessionId: string,
    failureCode: string,
    failureSummary: string
  ): Promise<void> {
    await this.db
      .update(uploadSessions)
      .set({
        status: "FAILED",
        failureCode,
        failureSummary,
        updatedAt: new Date(),
      })
      .where(
        and(eq(uploadSessions.id, sessionId), eq(uploadSessions.organizationId, organizationId))
      );
  }

  /**
   * Initiates a new resumable multipart upload session.
   */
  async initiateUpload(
    context: TenantContext,
    input: InitiateUploadInput,
    options?: { requestMetadata?: { clientIp?: string | null; userAgent?: string | null } }
  ): Promise<UploadSessionDTO> {
    this.assertCanMutate(context);

    const parsed = initiateUploadSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid upload session input");
    }

    const safeFileName = normalizeSafeFileName(parsed.data.fileName);

    // 1. Resolve dataset version and its parent project
    const verRows = await this.db
      .select({
        versionId: datasetVersions.id,
        datasetId: datasetVersions.datasetId,
        projectId: datasets.projectId,
        projectStatus: projects.status,
        projectArchivedAt: projects.archivedAt,
      })
      .from(datasetVersions)
      .innerJoin(
        datasets,
        and(
          eq(datasetVersions.datasetId, datasets.id),
          eq(datasetVersions.organizationId, datasets.organizationId)
        )
      )
      .innerJoin(
        projects,
        and(
          eq(datasets.projectId, projects.id),
          eq(datasets.organizationId, projects.organizationId)
        )
      )
      .where(
        and(
          eq(datasetVersions.id, parsed.data.datasetVersionId),
          eq(datasetVersions.organizationId, context.organizationId)
        )
      );

    const versionMeta = verRows[0];
    if (!versionMeta) {
      throw new ResourceNotFoundError("Dataset version not found");
    }

    // 2. Assert project access & active project check
    await this.permissionService.assertProjectAccess(context, versionMeta.projectId);

    if (versionMeta.projectStatus === "archived" || versionMeta.projectArchivedAt !== null) {
      throw new ValidationError("Cannot upload files to an archived project");
    }

    // 3. Compute part sizing plan
    const { partSize, totalParts } = calculatePartPlan(
      parsed.data.expectedSize,
      parsed.data.partSize
    );

    // 4. Build canonical deterministic object key
    const r2Key = buildDatasetSourceObjectKey({
      organizationId: context.organizationId,
      projectId: versionMeta.projectId,
      datasetVersionId: versionMeta.versionId,
      fileName: safeFileName,
    });

    // 5. Check for active upload session collision
    const existingActive = await this.db
      .select({
        id: uploadSessions.id,
        status: uploadSessions.status,
        expiresAt: uploadSessions.expiresAt,
      })
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.organizationId, context.organizationId),
          eq(uploadSessions.datasetVersionId, versionMeta.versionId),
          eq(uploadSessions.r2Key, r2Key),
          inArray(uploadSessions.status, ["CREATED", "UPLOADING", "UPLOADED", "VERIFYING"])
        )
      );

    const activeSession = existingActive.find((s) => s.expiresAt > new Date());
    if (activeSession) {
      throw new ConflictError(
        `An active upload session already exists for this file in this dataset version (session: ${activeSession.id})`
      );
    }

    // 6. Initiate multipart upload with R2 provider
    const createResult = await this.storageService.createMultipartUpload({
      objectKey: r2Key,
      contentType: parsed.data.contentType,
      metadata: {
        organizationId: context.organizationId,
        projectId: versionMeta.projectId,
        datasetVersionId: versionMeta.versionId,
        fileName: safeFileName,
      },
    });

    const sessionId = generateDomainId("upl");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);

    // 7. Insert upload session record with compensating abort on DB failure
    let createdRow: typeof uploadSessions.$inferSelect;
    try {
      const inserted = await this.db
        .insert(uploadSessions)
        .values({
          id: sessionId,
          organizationId: context.organizationId,
          projectId: versionMeta.projectId,
          datasetVersionId: versionMeta.versionId,
          r2Key,
          r2UploadId: createResult.uploadId,
          status: "CREATED",
          expectedSize: parsed.data.expectedSize,
          partSize,
          totalParts,
          expiresAt,
          failureCode: null,
          failureSummary: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const row = inserted[0];
      if (!row) {
        throw new Error("Failed to insert upload session row");
      }
      createdRow = row;
    } catch (dbError) {
      // Compensating Action: Best-effort abort in R2 to avoid orphaned multipart uploads
      try {
        await this.storageService.abortMultipartUpload({
          objectKey: r2Key,
          uploadId: createResult.uploadId,
        });
      } catch {
        // Suppress secondary cleanup failure so original DB error propagates cleanly
      }
      throw dbError;
    }

    // 8. Record upload.initiated audit event
    await this.auditService.recordUserAuditEvent({
      context,
      action: "upload.initiated",
      resourceType: "upload_session",
      resourceId: sessionId,
      metadata: {
        projectId: versionMeta.projectId,
        datasetVersionId: versionMeta.versionId,
        fileName: safeFileName,
        r2Key,
        expectedSize: parsed.data.expectedSize,
        partSize,
        totalParts,
      },
      clientIp: options?.requestMetadata?.clientIp,
      userAgent: options?.requestMetadata?.userAgent,
      timestamp: now,
    });

    return this.mapSessionRow(createdRow);
  }

  /**
   * Retrieves an upload session by ID with tenant and access assertions.
   */
  async getUploadSession(context: TenantContext, sessionId: string): Promise<UploadSessionDTO> {
    const rows = await this.db
      .select()
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.id, sessionId),
          eq(uploadSessions.organizationId, context.organizationId)
        )
      );

    const session = rows[0];
    if (!session) {
      throw new ResourceNotFoundError("Upload session not found");
    }

    await this.permissionService.assertProjectAccess(context, session.projectId);

    // If expired and currently in non-terminal state, reconcile before expiring
    if (
      session.expiresAt <= new Date() &&
      (session.status === "CREATED" ||
        session.status === "UPLOADING" ||
        session.status === "UPLOADED")
    ) {
      // Check if physical object was already completed in R2
      try {
        const head = await this.storageService.headObject({ objectKey: session.r2Key });
        if (head && head.contentLength === session.expectedSize) {
          // Completed object exists! Do NOT expire blindly; route to VERIFYING for completion reconciliation
          const now = new Date();
          await this.db
            .update(uploadSessions)
            .set({ status: "VERIFYING", updatedAt: now })
            .where(
              and(
                eq(uploadSessions.id, session.id),
                eq(uploadSessions.organizationId, context.organizationId)
              )
            );
          session.status = "VERIFYING";
          session.updatedAt = now;
          return this.mapSessionRow(session);
        }
      } catch {
        // HeadObject check failure; proceed to expire
      }

      const now = new Date();
      await this.db
        .update(uploadSessions)
        .set({ status: "EXPIRED", updatedAt: now })
        .where(
          and(
            eq(uploadSessions.id, session.id),
            eq(uploadSessions.organizationId, context.organizationId)
          )
        );
      session.status = "EXPIRED";
      session.updatedAt = now;

      // Best effort abort in R2
      try {
        await this.storageService.abortMultipartUpload({
          objectKey: session.r2Key,
          uploadId: session.r2UploadId,
        });
      } catch {
        // Ignored
      }
    }

    return this.mapSessionRow(session);
  }

  /**
   * Queries authoritative R2 state to return resume information (uploaded parts & missing parts).
   */
  async getResumeState(context: TenantContext, sessionId: string): Promise<ResumeStateDTO> {
    const session = await this.getUploadSession(context, sessionId);

    // Terminal or already verified sessions have empty missing parts
    if (session.status === "VERIFIED") {
      return {
        sessionId: session.id,
        status: session.status,
        totalParts: session.totalParts,
        partSize: session.partSize,
        expectedSize: session.expectedSize,
        uploadedParts: [],
        missingParts: [],
      };
    }

    if (
      session.status === "ABORTED" ||
      session.status === "FAILED" ||
      session.status === "EXPIRED" ||
      session.status === "QUARANTINED"
    ) {
      return {
        sessionId: session.id,
        status: session.status,
        totalParts: session.totalParts,
        partSize: session.partSize,
        expectedSize: session.expectedSize,
        uploadedParts: [],
        missingParts: [],
      };
    }

    // Query R2 authoritative multipart parts list
    try {
      const r2Parts = await this.storageService.listMultipartParts({
        objectKey: session.r2Key,
        uploadId: session.r2UploadId,
      });

      const uploadedPartNumbers = new Set<number>();
      const uploadedParts = r2Parts.map((p) => {
        uploadedPartNumbers.add(p.partNumber);
        return {
          partNumber: p.partNumber,
          eTag: p.eTag,
          sizeBytes: p.sizeBytes,
        };
      });

      const missingParts: number[] = [];
      for (let i = 1; i <= session.totalParts; i++) {
        if (!uploadedPartNumbers.has(i)) {
          missingParts.push(i);
        }
      }

      return {
        sessionId: session.id,
        status: session.status,
        totalParts: session.totalParts,
        partSize: session.partSize,
        expectedSize: session.expectedSize,
        uploadedParts,
        missingParts,
      };
    } catch (error) {
      // If R2 returns NoSuchUpload / MULTIPART_UPLOAD_NOT_FOUND, reconcile via headObject
      if (error instanceof StorageError && error.code === "MULTIPART_UPLOAD_NOT_FOUND") {
        const head = await this.storageService.headObject({ objectKey: session.r2Key });
        if (head && head.contentLength === session.expectedSize) {
          // Object already completed in R2!
          return {
            sessionId: session.id,
            status: "VERIFYING",
            totalParts: session.totalParts,
            partSize: session.partSize,
            expectedSize: session.expectedSize,
            uploadedParts: [],
            missingParts: [],
          };
        }

        // Upload lost or aborted in provider
        await this.markSessionFailed(
          context.organizationId,
          session.id,
          "R2_UPLOAD_NOT_FOUND",
          "Multipart upload was not found in R2 and object does not exist"
        );

        return {
          sessionId: session.id,
          status: "FAILED",
          totalParts: session.totalParts,
          partSize: session.partSize,
          expectedSize: session.expectedSize,
          uploadedParts: [],
          missingParts: [],
        };
      }

      // Transient provider errors must not mark FAILED
      if (error instanceof StorageError && error.isRetryable) {
        throw error;
      }

      throw error;
    }
  }

  /**
   * Generates presigned URLs for client-side direct upload of specific part numbers.
   * Advances session status from CREATED to UPLOADING.
   */
  async createPartUploadUrls(
    context: TenantContext,
    input: CreatePartUploadUrlsInput
  ): Promise<UploadPartUrlDTO[]> {
    this.assertCanMutate(context);

    const parsed = createPartUploadUrlsSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid part URLs input");
    }

    const session = await this.getUploadSession(context, parsed.data.sessionId);

    if (session.status === "EXPIRED" || session.expiresAt <= new Date()) {
      throw new ValidationError("Upload session has expired");
    }

    if (
      session.status !== "CREATED" &&
      session.status !== "UPLOADING" &&
      session.status !== "UPLOADED"
    ) {
      throw new ValidationError(
        `Cannot generate upload URLs for session in status '${session.status}'`
      );
    }

    // Verify parent project is not archived
    const projRows = await this.db
      .select({ status: projects.status, archivedAt: projects.archivedAt })
      .from(projects)
      .where(
        and(eq(projects.id, session.projectId), eq(projects.organizationId, context.organizationId))
      );

    const project = projRows[0];
    if (!project || project.status === "archived" || project.archivedAt !== null) {
      throw new ValidationError("Cannot upload to an archived project");
    }

    // Validate part numbers against session bounds
    const uniquePartNumbers = Array.from(new Set(parsed.data.partNumbers)).sort((a, b) => a - b);
    for (const partNum of uniquePartNumbers) {
      if (partNum < 1 || partNum > session.totalParts) {
        throw new ValidationError(
          `partNumber ${partNum} is out of bounds (1..${session.totalParts})`
        );
      }
    }

    // Advance CREATED -> UPLOADING conditionally
    if (session.status === "CREATED") {
      await this.db
        .update(uploadSessions)
        .set({ status: "UPLOADING", updatedAt: new Date() })
        .where(
          and(
            eq(uploadSessions.id, session.id),
            eq(uploadSessions.organizationId, context.organizationId),
            eq(uploadSessions.status, "CREATED")
          )
        );
    }

    // Generate presigned URLs concurrently
    const urls: UploadPartUrlDTO[] = await Promise.all(
      uniquePartNumbers.map(async (partNumber) => {
        const presignedUrl = await this.storageService.createPresignedUploadPartUrl({
          objectKey: session.r2Key,
          uploadId: session.r2UploadId,
          partNumber,
          expiresInSeconds: STORAGE_DEFAULTS.PRESIGNED_UPLOAD_PART_EXPIRES_SECONDS,
        });

        return {
          partNumber,
          presignedUrl,
          expiresInSeconds: STORAGE_DEFAULTS.PRESIGNED_UPLOAD_PART_EXPIRES_SECONDS,
        };
      })
    );

    return urls;
  }

  /**
   * Finalizes the upload session once all parts have been uploaded to R2.
   *
   * Locked Canonical Lifecycle:
   * CREATED -> UPLOADING -> UPLOADED -> VERIFYING -> VERIFIED
   *
   * Invariants & Rules:
   * 1. If called while CREATED, reconciles R2 ListParts and steps through valid lifecycle.
   * 2. After ListParts proves all parts exist:
   *    - Conditionally transitions UPLOADING -> UPLOADED.
   *    - Conditionally transitions UPLOADED -> VERIFYING.
   *    - Never skips UPLOADED or VERIFYING.
   * 3. CompleteMultipartUpload executed in VERIFYING state.
   * 4. If already VERIFIED, returns existing DTO without calling R2 or writing duplicate audit events.
   * 5. If NoSuchUpload occurs:
   *    - Reconciles via HeadObject. If object exists and matches size, continues to binding.
   *    - If absent or size mismatch, marks FAILED.
   * 6. Transient provider errors (PROVIDER_UNAVAILABLE, isRetryable: true) do NOT mark FAILED.
   */
  async completeUpload(
    context: TenantContext,
    sessionId: string,
    options?: { requestMetadata?: { clientIp?: string | null; userAgent?: string | null } }
  ): Promise<CompleteUploadResultDTO> {
    this.assertCanMutate(context);

    let session = await this.getUploadSession(context, sessionId);

    // 1. Idempotent short-circuit if already VERIFIED
    if (session.status === "VERIFIED") {
      const existingFiles = await this.db
        .select()
        .from(datasetFiles)
        .where(
          and(
            eq(datasetFiles.datasetVersionId, session.datasetVersionId),
            eq(datasetFiles.r2Key, session.r2Key),
            eq(datasetFiles.organizationId, context.organizationId)
          )
        );

      const file = existingFiles[0];
      if (file) {
        return {
          session,
          file: {
            id: file.id,
            organizationId: file.organizationId,
            datasetVersionId: file.datasetVersionId,
            r2Key: file.r2Key,
            byteSize: file.byteSize,
            fileName: file.fileName,
            contentType: file.contentType,
            eTag: file.eTag,
            createdAt: file.createdAt,
          },
        };
      }
    }

    if (
      session.status === "ABORTED" ||
      session.status === "FAILED" ||
      session.status === "EXPIRED" ||
      session.status === "QUARANTINED"
    ) {
      throw new ValidationError(
        `Cannot complete upload session in terminal status '${session.status}'`
      );
    }

    if (session.expiresAt <= new Date() && session.status !== "VERIFYING") {
      throw new ValidationError("Upload session has expired");
    }

    // 2. Reconciliation path if already VERIFYING (e.g. from prior interrupted attempt)
    if (session.status === "VERIFYING") {
      const head = await this.storageService.headObject({ objectKey: session.r2Key });
      if (head && head.contentLength === session.expectedSize) {
        return await this.bindCompletedDatasetFile(context, session, head, options);
      } else if (head && head.contentLength !== session.expectedSize) {
        await this.markSessionFailed(
          context.organizationId,
          session.id,
          "SIZE_MISMATCH",
          `Expected ${session.expectedSize} bytes, got ${head.contentLength} bytes`
        );
        throw new ValidationError(
          `Uploaded object size (${head.contentLength}) does not match expected size (${session.expectedSize})`
        );
      }
    }

    // 3. Authoritative check: verify all parts are present in R2
    let r2Parts: readonly { partNumber: number; eTag: string }[];
    try {
      r2Parts = await this.storageService.listMultipartParts({
        objectKey: session.r2Key,
        uploadId: session.r2UploadId,
      });
    } catch (error) {
      // If NoSuchUpload, inspect if object is already assembled via HeadObject
      if (error instanceof StorageError && error.code === "MULTIPART_UPLOAD_NOT_FOUND") {
        const head = await this.storageService.headObject({ objectKey: session.r2Key });
        if (head && head.contentLength === session.expectedSize) {
          // Object already finalized in R2; advance to VERIFYING if needed and bind
          if (session.status !== "VERIFYING") {
            await this.db
              .update(uploadSessions)
              .set({ status: "VERIFYING", updatedAt: new Date() })
              .where(
                and(
                  eq(uploadSessions.id, session.id),
                  eq(uploadSessions.organizationId, context.organizationId)
                )
              );
            session = { ...session, status: "VERIFYING" };
          }
          return await this.bindCompletedDatasetFile(context, session, head, options);
        } else if (head && head.contentLength !== session.expectedSize) {
          await this.markSessionFailed(
            context.organizationId,
            session.id,
            "SIZE_MISMATCH",
            `Expected ${session.expectedSize} bytes, got ${head.contentLength} bytes`
          );
          throw new ValidationError(
            `Uploaded object size (${head.contentLength}) does not match expected size (${session.expectedSize})`
          );
        } else {
          await this.markSessionFailed(
            context.organizationId,
            session.id,
            "R2_UPLOAD_NOT_FOUND",
            "Multipart upload was not found in storage and assembled object does not exist"
          );
          throw new ValidationError(
            "Multipart upload was not found in storage and assembled object does not exist"
          );
        }
      }

      // Transient provider errors must not mark FAILED
      if (error instanceof StorageError && error.isRetryable) {
        throw error;
      }

      throw error;
    }

    const uploadedNumbers = new Set(r2Parts.map((p) => p.partNumber));
    const missingParts: number[] = [];
    for (let i = 1; i <= session.totalParts; i++) {
      if (!uploadedNumbers.has(i)) {
        missingParts.push(i);
      }
    }

    if (missingParts.length > 0) {
      const displayMissing = missingParts.slice(0, 10).join(", ");
      const extra = missingParts.length > 10 ? ` and ${missingParts.length - 10} more` : "";
      throw new ValidationError(
        `Cannot complete upload: missing ${missingParts.length} parts [${displayMissing}${extra}]`
      );
    }

    // 4. Canonical State Machine Progression:
    // CREATED -> UPLOADING -> UPLOADED -> VERIFYING -> VERIFIED
    // Must not skip UPLOADED or VERIFYING.

    // A. CREATED -> UPLOADING (if called from CREATED with all parts already uploaded)
    if (session.status === "CREATED") {
      await this.db
        .update(uploadSessions)
        .set({ status: "UPLOADING", updatedAt: new Date() })
        .where(
          and(
            eq(uploadSessions.id, session.id),
            eq(uploadSessions.organizationId, context.organizationId),
            eq(uploadSessions.status, "CREATED")
          )
        );
      session = { ...session, status: "UPLOADING" };
    }

    // B. UPLOADING -> UPLOADED
    if (session.status === "UPLOADING") {
      await this.db
        .update(uploadSessions)
        .set({ status: "UPLOADED", updatedAt: new Date() })
        .where(
          and(
            eq(uploadSessions.id, session.id),
            eq(uploadSessions.organizationId, context.organizationId),
            eq(uploadSessions.status, "UPLOADING")
          )
        );
      session = { ...session, status: "UPLOADED" };
    }

    // C. UPLOADED -> VERIFYING
    if (session.status === "UPLOADED") {
      await this.db
        .update(uploadSessions)
        .set({ status: "VERIFYING", updatedAt: new Date() })
        .where(
          and(
            eq(uploadSessions.id, session.id),
            eq(uploadSessions.organizationId, context.organizationId),
            eq(uploadSessions.status, "UPLOADED")
          )
        );
      session = { ...session, status: "VERIFYING" };
    }

    // 5. Complete multipart upload in R2
    let completeResult: { eTag: string } | null = null;
    try {
      completeResult = await this.storageService.completeMultipartUpload({
        objectKey: session.r2Key,
        uploadId: session.r2UploadId,
        parts: r2Parts.map((p) => ({ partNumber: p.partNumber, eTag: p.eTag })),
      });
    } catch (completeErr) {
      if (
        completeErr instanceof StorageError &&
        completeErr.code === "MULTIPART_UPLOAD_NOT_FOUND"
      ) {
        // Multipart upload already completed or finalized; verify via HeadObject below
      } else if (completeErr instanceof StorageError && completeErr.isRetryable) {
        // Transient error: do NOT mark FAILED. Session remains in VERIFYING for retry.
        throw completeErr;
      } else {
        throw completeErr;
      }
    }

    // 6. Verify assembled object in R2 via HeadObject
    const head = await this.storageService.headObject({ objectKey: session.r2Key });
    if (!head) {
      await this.markSessionFailed(
        context.organizationId,
        session.id,
        "OBJECT_NOT_FOUND_AFTER_COMPLETION",
        "Object could not be found in storage following multipart completion"
      );
      throw new Error("Object was not found in storage after multipart completion");
    }

    if (head.contentLength !== session.expectedSize) {
      await this.markSessionFailed(
        context.organizationId,
        session.id,
        "SIZE_MISMATCH",
        `Expected ${session.expectedSize} bytes, got ${head.contentLength} bytes`
      );
      throw new ValidationError(
        `Uploaded object size (${head.contentLength}) does not match expected size (${session.expectedSize})`
      );
    }

    // 7. Bind completed dataset_files and update upload_sessions inside DB transaction
    return await this.bindCompletedDatasetFile(
      context,
      session,
      { ...head, eTag: completeResult?.eTag || head.eTag },
      options
    );
  }

  /**
   * Binds the verified physical R2 object to dataset_files and finalizes upload_sessions to VERIFIED.
   *
   * Idempotency & Invariants:
   * 1. Checks existing dataset_files binding.
   * 2. If present, validates immutable consistency (organizationId, datasetVersionId, r2Key, byteSize, eTag).
   *    If mismatching, raises IntegrityError.
   * 3. If insert encounters conflict, re-reads row and validates immutable consistency.
   * 4. Transitions upload_sessions from VERIFYING -> VERIFIED.
   * 5. The transaction that first establishes VERIFYING -> VERIFIED emits upload.completed audit event.
   */
  private async bindCompletedDatasetFile(
    context: TenantContext,
    session: UploadSessionDTO,
    head: { contentLength: number; eTag: string; contentType?: string },
    options?: { requestMetadata?: { clientIp?: string | null; userAgent?: string | null } }
  ): Promise<CompleteUploadResultDTO> {
    const fileId = generateDomainId("dsf");
    const now = new Date();
    const fileName = session.r2Key.split("/").pop() ?? "file";

    return await this.db.transaction(async (tx) => {
      // 1. Query existing dataset_files
      const existingFiles = await tx
        .select()
        .from(datasetFiles)
        .where(
          and(
            eq(datasetFiles.datasetVersionId, session.datasetVersionId),
            eq(datasetFiles.r2Key, session.r2Key)
          )
        );

      let activeFile: typeof datasetFiles.$inferSelect;
      const existing = existingFiles[0];

      if (existing) {
        // Validate immutable consistency
        if (
          existing.organizationId !== context.organizationId ||
          existing.datasetVersionId !== session.datasetVersionId ||
          existing.r2Key !== session.r2Key ||
          existing.byteSize !== head.contentLength
        ) {
          throw new IntegrityError(
            `Immutable dataset file mismatch for key ${session.r2Key}: existing byteSize=${existing.byteSize}, expected=${head.contentLength}`
          );
        }
        if (head.eTag && existing.eTag && existing.eTag !== head.eTag) {
          throw new IntegrityError(
            `Immutable dataset file ETag mismatch for key ${session.r2Key}: existing=${existing.eTag}, expected=${head.eTag}`
          );
        }
        activeFile = existing;
      } else {
        // Attempt INSERT
        try {
          const inserted = await tx
            .insert(datasetFiles)
            .values({
              id: fileId,
              organizationId: context.organizationId,
              datasetVersionId: session.datasetVersionId,
              r2Key: session.r2Key,
              byteSize: head.contentLength,
              fileName,
              contentType: head.contentType ?? "application/octet-stream",
              eTag: head.eTag,
              createdAt: now,
            })
            .returning();

          const created = inserted[0];
          if (!created) {
            throw new Error("Failed to insert dataset file binding");
          }
          activeFile = created;
        } catch (insertError) {
          // Retry race: another transaction inserted first
          const reRead = await tx
            .select()
            .from(datasetFiles)
            .where(
              and(
                eq(datasetFiles.datasetVersionId, session.datasetVersionId),
                eq(datasetFiles.r2Key, session.r2Key)
              )
            );

          const conflictRow = reRead[0];
          if (!conflictRow) {
            throw insertError;
          }

          // Validate immutable consistency on conflicting row
          if (
            conflictRow.organizationId !== context.organizationId ||
            conflictRow.datasetVersionId !== session.datasetVersionId ||
            conflictRow.r2Key !== session.r2Key ||
            conflictRow.byteSize !== head.contentLength
          ) {
            throw new IntegrityError(
              `Immutable dataset file conflict mismatch for key ${session.r2Key}: existing byteSize=${conflictRow.byteSize}, expected=${head.contentLength}`
            );
          }
          if (head.eTag && conflictRow.eTag && conflictRow.eTag !== head.eTag) {
            throw new IntegrityError(
              `Immutable dataset file conflict ETag mismatch for key ${session.r2Key}: existing=${conflictRow.eTag}, expected=${head.eTag}`
            );
          }
          activeFile = conflictRow;
        }
      }

      // 2. Finalize upload_sessions row (conditional transition VERIFYING -> VERIFIED)
      const updatedSessions = await tx
        .update(uploadSessions)
        .set({
          status: "VERIFIED",
          failureCode: null,
          failureSummary: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(uploadSessions.id, session.id),
            eq(uploadSessions.organizationId, context.organizationId),
            eq(uploadSessions.status, "VERIFYING")
          )
        )
        .returning();

      let finalizedSession: UploadSessionDTO;

      if (updatedSessions[0]) {
        // This transaction successfully transitioned VERIFYING -> VERIFIED!
        // It owns the emission of the upload.completed audit event.
        finalizedSession = this.mapSessionRow(updatedSessions[0]);

        await this.auditService.recordUserAuditEvent({
          db: tx,
          context,
          action: "upload.completed",
          resourceType: "upload_session",
          resourceId: session.id,
          metadata: {
            projectId: session.projectId,
            datasetVersionId: session.datasetVersionId,
            r2Key: session.r2Key,
            byteSize: head.contentLength,
            eTag: head.eTag,
          },
          clientIp: options?.requestMetadata?.clientIp,
          userAgent: options?.requestMetadata?.userAgent,
          timestamp: now,
        });
      } else {
        // Already transitioned to VERIFIED by a concurrent or prior commit
        const currentSession = await tx
          .select()
          .from(uploadSessions)
          .where(
            and(
              eq(uploadSessions.id, session.id),
              eq(uploadSessions.organizationId, context.organizationId)
            )
          );

        if (!currentSession[0] || currentSession[0].status !== "VERIFIED") {
          throw new Error("Failed to finalize upload session in VERIFIED status");
        }
        finalizedSession = this.mapSessionRow(currentSession[0]);
        // Do NOT emit a duplicate upload.completed audit event
      }

      return {
        session: finalizedSession,
        file: {
          id: activeFile.id,
          organizationId: activeFile.organizationId,
          datasetVersionId: activeFile.datasetVersionId,
          r2Key: activeFile.r2Key,
          byteSize: activeFile.byteSize,
          fileName: activeFile.fileName,
          contentType: activeFile.contentType,
          eTag: activeFile.eTag,
          createdAt: activeFile.createdAt,
        },
      };
    });
  }

  /**
   * Aborts an active upload session and cleans up incomplete parts in R2.
   *
   * Invariants:
   * 1. VERIFYING abort rule: Does NOT allow blind abort while in VERIFYING status.
   *    Performs HeadObject reconciliation first.
   * 2. If provider returns MULTIPART_UPLOAD_NOT_FOUND, checks HeadObject before marking ABORTED.
   * 3. Never converts a completed physical object into an ABORTED logical session.
   */
  async abortUpload(
    context: TenantContext,
    sessionId: string,
    options?: { requestMetadata?: { clientIp?: string | null; userAgent?: string | null } }
  ): Promise<UploadSessionDTO> {
    this.assertCanMutate(context);

    const session = await this.getUploadSession(context, sessionId);

    if (session.status === "ABORTED") {
      return session;
    }

    if (session.status === "VERIFIED" || session.status === "IMPORTED") {
      throw new ValidationError(
        `Cannot abort an upload session that has already been verified/imported`
      );
    }

    // VERIFYING abort guard: physical completion may already have occurred
    if (session.status === "VERIFYING") {
      const head = await this.storageService.headObject({ objectKey: session.r2Key });
      if (head && head.contentLength === session.expectedSize) {
        throw new ConflictError(
          "Cannot abort upload session: upload has already completed in storage"
        );
      } else if (head && head.contentLength !== session.expectedSize) {
        throw new IntegrityError(
          `Storage object exists with mismatched size (${head.contentLength} vs expected ${session.expectedSize}) during abort`
        );
      }
      // Object not completed; proceed with abort attempt
    }

    // Attempt provider abort in R2
    try {
      await this.storageService.abortMultipartUpload({
        objectKey: session.r2Key,
        uploadId: session.r2UploadId,
      });
    } catch (error) {
      if (error instanceof StorageError && error.code === "MULTIPART_UPLOAD_NOT_FOUND") {
        // NoSuchUpload: inspect if object already exists
        const head = await this.storageService.headObject({ objectKey: session.r2Key });
        if (head && head.contentLength === session.expectedSize) {
          throw new ConflictError(
            "Cannot abort upload session: upload has already completed in storage"
          );
        } else if (head && head.contentLength !== session.expectedSize) {
          throw new IntegrityError(
            `Storage object exists with mismatched size (${head.contentLength} vs expected ${session.expectedSize}) during abort`
          );
        }
        // Object does not exist in storage: safe to proceed with abort
      } else if (error instanceof StorageError && error.isRetryable) {
        // Transient error: do NOT mark ABORTED, allow caller to retry
        throw error;
      } else {
        // Other non-fatal errors during abort can be logged/suppressed or rethrown
      }
    }

    const now = new Date();
    const updatedRows = await this.db
      .update(uploadSessions)
      .set({
        status: "ABORTED",
        updatedAt: now,
      })
      .where(
        and(
          eq(uploadSessions.id, session.id),
          eq(uploadSessions.organizationId, context.organizationId),
          inArray(uploadSessions.status, ["CREATED", "UPLOADING", "UPLOADED", "VERIFYING"])
        )
      )
      .returning();

    const updated = updatedRows[0];
    if (!updated) {
      // Re-read in case of concurrent abort
      const reRead = await this.db
        .select()
        .from(uploadSessions)
        .where(
          and(
            eq(uploadSessions.id, session.id),
            eq(uploadSessions.organizationId, context.organizationId)
          )
        );
      if (reRead[0] && reRead[0].status === "ABORTED") {
        return this.mapSessionRow(reRead[0]);
      }
      throw new ConflictError("Failed to abort upload session due to concurrent state change");
    }

    await this.auditService.recordUserAuditEvent({
      context,
      action: "upload.aborted",
      resourceType: "upload_session",
      resourceId: session.id,
      metadata: {
        projectId: session.projectId,
        datasetVersionId: session.datasetVersionId,
        r2Key: session.r2Key,
      },
      clientIp: options?.requestMetadata?.clientIp,
      userAgent: options?.requestMetadata?.userAgent,
      timestamp: now,
    });

    return this.mapSessionRow(updated);
  }

  /**
   * Maintenance method to expire an upload session whose TTL has lapsed.
   *
   * Invariants:
   * 1. Never expires VERIFYING, VERIFIED, or IMPORTED sessions.
   * 2. Checks HeadObject before expiring: if completed object exists, does NOT expire.
   */
  async expireUploadSession(sessionId: string, organizationId: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(uploadSessions)
      .where(
        and(eq(uploadSessions.id, sessionId), eq(uploadSessions.organizationId, organizationId))
      );

    const session = rows[0];
    if (!session) return;

    // Never expire VERIFYING, VERIFIED, or IMPORTED
    if (
      session.status === "VERIFYING" ||
      session.status === "VERIFIED" ||
      session.status === "IMPORTED" ||
      session.status === "ABORTED" ||
      session.status === "FAILED" ||
      session.status === "EXPIRED"
    ) {
      return;
    }

    // Inspect if object is already completed in storage
    try {
      const head = await this.storageService.headObject({ objectKey: session.r2Key });
      if (head && head.contentLength === session.expectedSize) {
        // Completed object exists! Leave session recoverable for completion reconciliation
        await this.db
          .update(uploadSessions)
          .set({ status: "VERIFYING", updatedAt: new Date() })
          .where(
            and(eq(uploadSessions.id, sessionId), eq(uploadSessions.organizationId, organizationId))
          );
        return;
      }
    } catch {
      // Head check error; proceed to abort attempt
    }

    // Best-effort abort in R2
    try {
      await this.storageService.abortMultipartUpload({
        objectKey: session.r2Key,
        uploadId: session.r2UploadId,
      });
    } catch {
      // Suppress
    }

    await this.db
      .update(uploadSessions)
      .set({
        status: "EXPIRED",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(uploadSessions.id, sessionId),
          eq(uploadSessions.organizationId, organizationId),
          inArray(uploadSessions.status, ["CREATED", "UPLOADING", "UPLOADED"])
        )
      );
  }
}

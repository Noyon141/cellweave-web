import { eq, and } from "drizzle-orm";
import { z } from "zod";
import type { TenantContext } from "@/types";
import { generateDomainId } from "@/lib/id";
import { getDb, type DbClient } from "../database/client";
import { samples } from "../database/schema/samples";
import { experiments } from "../database/schema/experiments";
import { projects } from "../database/schema/projects";
import {
  ConflictError,
  ResourceNotFoundError,
  TenantAuthorizationError,
  ValidationError,
} from "../authorization/errors";
import { AuditService } from "./audit-service";
import { ProjectPermissionService } from "./project-permission-service";

export interface SampleDTO {
  id: string;
  organizationId: string;
  experimentId: string;
  sampleKey: string;
  displayName: string | null;
  condition: string | null;
  batch: string | null;
  biologicalReplicate: string | null;
  technicalReplicate: string | null;
  metadataJson: Record<string, unknown>;
}

export const createSampleSchema = z.object({
  sampleKey: z
    .string()
    .trim()
    .min(1, "Sample key is required")
    .max(100, "Sample key cannot exceed 100 characters")
    .refine((val) => !/[\x00-\x1F\x7F]/.test(val), "Sample key cannot contain control characters"),
  displayName: z
    .string()
    .trim()
    .max(255, "Display name cannot exceed 255 characters")
    .nullable()
    .optional(),
  condition: z
    .string()
    .trim()
    .max(100, "Condition cannot exceed 100 characters")
    .nullable()
    .optional(),
  batch: z.string().trim().max(100, "Batch cannot exceed 100 characters").nullable().optional(),
  biologicalReplicate: z
    .string()
    .trim()
    .max(50, "Biological replicate cannot exceed 50 characters")
    .nullable()
    .optional(),
  technicalReplicate: z
    .string()
    .trim()
    .max(50, "Technical replicate cannot exceed 50 characters")
    .nullable()
    .optional(),
  metadataJson: z.record(z.unknown()).optional(),
});

export type CreateSampleInput = z.infer<typeof createSampleSchema>;

export const updateSampleSchema = z.object({
  displayName: z
    .string()
    .trim()
    .max(255, "Display name cannot exceed 255 characters")
    .nullable()
    .optional(),
  condition: z
    .string()
    .trim()
    .max(100, "Condition cannot exceed 100 characters")
    .nullable()
    .optional(),
  batch: z.string().trim().max(100, "Batch cannot exceed 100 characters").nullable().optional(),
  biologicalReplicate: z
    .string()
    .trim()
    .max(50, "Biological replicate cannot exceed 50 characters")
    .nullable()
    .optional(),
  technicalReplicate: z
    .string()
    .trim()
    .max(50, "Technical replicate cannot exceed 50 characters")
    .nullable()
    .optional(),
  metadataJson: z.record(z.unknown()).optional(),
});

export type UpdateSampleInput = z.infer<typeof updateSampleSchema>;

export interface SampleServiceOptions {
  dbClient?: DbClient;
  auditService?: AuditService;
  permissionService?: ProjectPermissionService;
}

/**
 * Sample Application Service (Phase 2 Biological/Technical Sample Coordinate)
 *
 * Core Tenancy & Master Design Invariants:
 * 1. Strict Tenant Scoping: All queries & mutations include organizationId = context.organizationId.
 * 2. Hierarchy Resolution: sample -> experiment -> project.
 *    - Asserts project access on the experiment's parent project.
 * 3. Role Authorization:
 *    - Mutations require role in [owner, admin, bioinformatician, scientist].
 *    - Viewer role is strictly read-only.
 * 4. Invariant: sampleKey is strictly unique per experimentId.
 *    - Catches unique violation or duplicate checks and throws ConflictError.
 * 5. Archived Project Guard:
 *    - Mutations on samples in archived projects are strictly rejected.
 * 6. Audit Logging:
 *    - Records sample.created and sample.updated.
 * 7. Identifiers:
 *    - Generates sample IDs using centralized UUIDv7 generateDomainId("smp").
 */
export class SampleService {
  private readonly db: DbClient;
  private readonly auditService: AuditService;
  private readonly permissionService: ProjectPermissionService;

  constructor(options: SampleServiceOptions = {}) {
    this.db = options.dbClient ?? getDb();
    this.auditService = options.auditService ?? new AuditService({ dbClient: this.db });
    this.permissionService =
      options.permissionService ??
      new ProjectPermissionService({ dbClient: this.db, auditService: this.auditService });
  }

  private assertCanMutate(context: TenantContext): void {
    if (context.role === "viewer") {
      throw new TenantAuthorizationError("Viewer role is not authorized to modify samples");
    }
  }

  /**
   * Creates a sample inside an active experiment.
   */
  async createSample(
    context: TenantContext,
    experimentId: string,
    input: CreateSampleInput,
    options?: { requestMetadata?: { clientIp?: string | null; userAgent?: string | null } }
  ): Promise<SampleDTO> {
    this.assertCanMutate(context);

    const parsed = createSampleSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid sample input");
    }

    const sampleId = generateDomainId("smp");
    const now = new Date();

    return await this.db.transaction(async (tx) => {
      // 1. Resolve experiment and its parent project
      const expRows = await tx
        .select({
          id: experiments.id,
          projectId: experiments.projectId,
          projectStatus: projects.status,
          projectArchivedAt: projects.archivedAt,
        })
        .from(experiments)
        .innerJoin(
          projects,
          and(
            eq(experiments.projectId, projects.id),
            eq(experiments.organizationId, projects.organizationId)
          )
        )
        .where(
          and(
            eq(experiments.id, experimentId),
            eq(experiments.organizationId, context.organizationId)
          )
        );

      const exp = expRows[0];
      if (!exp) {
        throw new ResourceNotFoundError("Experiment not found");
      }

      await this.permissionService.assertProjectAccess(context, exp.projectId);

      if (exp.projectStatus === "archived" || exp.projectArchivedAt !== null) {
        throw new ValidationError("Cannot create samples in an archived project");
      }

      // 2. Check for duplicate sampleKey in this experiment
      const existingKeyRows = await tx
        .select({ id: samples.id })
        .from(samples)
        .where(
          and(
            eq(samples.experimentId, experimentId),
            eq(samples.sampleKey, parsed.data.sampleKey),
            eq(samples.organizationId, context.organizationId)
          )
        );

      if (existingKeyRows.length > 0) {
        throw new ConflictError(
          `Sample with key '${parsed.data.sampleKey}' already exists in this experiment`
        );
      }

      let inserted;
      try {
        inserted = await tx
          .insert(samples)
          .values({
            id: sampleId,
            organizationId: context.organizationId,
            experimentId,
            sampleKey: parsed.data.sampleKey,
            displayName: parsed.data.displayName ?? null,
            condition: parsed.data.condition ?? null,
            batch: parsed.data.batch ?? null,
            biologicalReplicate: parsed.data.biologicalReplicate ?? null,
            technicalReplicate: parsed.data.technicalReplicate ?? null,
            metadataJson: (parsed.data.metadataJson ?? {}) as Record<string, unknown>,
          })
          .returning();
      } catch (err: unknown) {
        const error = err as { code?: string; message?: string };
        if (error.code === "23505") {
          throw new ConflictError(
            `Sample with key '${parsed.data.sampleKey}' already exists in this experiment`
          );
        }
        throw err;
      }

      const created = inserted[0];
      if (!created) {
        throw new Error("Failed to insert sample record");
      }

      await this.auditService.recordUserAuditEvent({
        db: tx,
        context,
        action: "sample.created",
        resourceType: "sample",
        resourceId: sampleId,
        metadata: {
          experimentId,
          sampleKey: created.sampleKey,
          condition: created.condition,
          batch: created.batch,
        },
        clientIp: options?.requestMetadata?.clientIp,
        userAgent: options?.requestMetadata?.userAgent,
        timestamp: now,
      });

      return {
        id: created.id,
        organizationId: created.organizationId,
        experimentId: created.experimentId,
        sampleKey: created.sampleKey,
        displayName: created.displayName,
        condition: created.condition,
        batch: created.batch,
        biologicalReplicate: created.biologicalReplicate,
        technicalReplicate: created.technicalReplicate,
        metadataJson: (created.metadataJson ?? {}) as Record<string, unknown>,
      };
    });
  }

  /**
   * Retrieves a sample by ID.
   */
  async getSample(context: TenantContext, sampleId: string): Promise<SampleDTO> {
    const rows = await this.db
      .select({
        sample: samples,
        projectId: experiments.projectId,
      })
      .from(samples)
      .innerJoin(
        experiments,
        and(
          eq(samples.experimentId, experiments.id),
          eq(samples.organizationId, experiments.organizationId)
        )
      )
      .where(and(eq(samples.id, sampleId), eq(samples.organizationId, context.organizationId)));

    const record = rows[0];
    if (!record) {
      throw new ResourceNotFoundError("Sample not found");
    }

    await this.permissionService.assertProjectAccess(context, record.projectId);

    const s = record.sample;
    return {
      id: s.id,
      organizationId: s.organizationId,
      experimentId: s.experimentId,
      sampleKey: s.sampleKey,
      displayName: s.displayName,
      condition: s.condition,
      batch: s.batch,
      biologicalReplicate: s.biologicalReplicate,
      technicalReplicate: s.technicalReplicate,
      metadataJson: (s.metadataJson ?? {}) as Record<string, unknown>,
    };
  }

  /**
   * Lists samples belonging to an experiment.
   */
  async listExperimentSamples(context: TenantContext, experimentId: string): Promise<SampleDTO[]> {
    // 1. Resolve experiment parent project to assert access
    const expRows = await this.db
      .select({
        id: experiments.id,
        projectId: experiments.projectId,
      })
      .from(experiments)
      .where(
        and(
          eq(experiments.id, experimentId),
          eq(experiments.organizationId, context.organizationId)
        )
      );

    const exp = expRows[0];
    if (!exp) {
      throw new ResourceNotFoundError("Experiment not found");
    }

    await this.permissionService.assertProjectAccess(context, exp.projectId);

    const rows = await this.db
      .select()
      .from(samples)
      .where(
        and(
          eq(samples.experimentId, experimentId),
          eq(samples.organizationId, context.organizationId)
        )
      );

    return rows.map((s) => ({
      id: s.id,
      organizationId: s.organizationId,
      experimentId: s.experimentId,
      sampleKey: s.sampleKey,
      displayName: s.displayName,
      condition: s.condition,
      batch: s.batch,
      biologicalReplicate: s.biologicalReplicate,
      technicalReplicate: s.technicalReplicate,
      metadataJson: (s.metadataJson ?? {}) as Record<string, unknown>,
    }));
  }

  /**
   * Updates a sample's whitelisted metadata fields.
   */
  async updateSample(
    context: TenantContext,
    sampleId: string,
    input: UpdateSampleInput,
    options?: { requestMetadata?: { clientIp?: string | null; userAgent?: string | null } }
  ): Promise<SampleDTO> {
    this.assertCanMutate(context);

    const parsed = updateSampleSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid sample update payload");
    }

    const { displayName, condition, batch, biologicalReplicate, technicalReplicate, metadataJson } =
      parsed.data;

    if (
      displayName === undefined &&
      condition === undefined &&
      batch === undefined &&
      biologicalReplicate === undefined &&
      technicalReplicate === undefined &&
      metadataJson === undefined
    ) {
      throw new ValidationError("At least one field must be provided for update");
    }

    return await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          sample: samples,
          projectId: experiments.projectId,
          projectStatus: projects.status,
          projectArchivedAt: projects.archivedAt,
        })
        .from(samples)
        .innerJoin(
          experiments,
          and(
            eq(samples.experimentId, experiments.id),
            eq(samples.organizationId, experiments.organizationId)
          )
        )
        .innerJoin(
          projects,
          and(
            eq(experiments.projectId, projects.id),
            eq(experiments.organizationId, projects.organizationId)
          )
        )
        .where(and(eq(samples.id, sampleId), eq(samples.organizationId, context.organizationId)));

      const existing = rows[0];
      if (!existing) {
        throw new ResourceNotFoundError("Sample not found");
      }

      await this.permissionService.assertProjectAccess(context, existing.projectId);

      if (existing.projectStatus === "archived" || existing.projectArchivedAt !== null) {
        throw new ValidationError("Cannot modify samples in an archived project");
      }

      const updateValues: Partial<typeof samples.$inferInsert> = {};
      if (displayName !== undefined) updateValues.displayName = displayName;
      if (condition !== undefined) updateValues.condition = condition;
      if (batch !== undefined) updateValues.batch = batch;
      if (biologicalReplicate !== undefined) updateValues.biologicalReplicate = biologicalReplicate;
      if (technicalReplicate !== undefined) updateValues.technicalReplicate = technicalReplicate;
      if (metadataJson !== undefined) {
        updateValues.metadataJson = metadataJson as Record<string, unknown>;
      }

      const updatedRows = await tx
        .update(samples)
        .set(updateValues)
        .where(and(eq(samples.id, sampleId), eq(samples.organizationId, context.organizationId)))
        .returning();

      const updated = updatedRows[0];
      if (!updated) {
        throw new Error("Failed to update sample");
      }

      await this.auditService.recordUserAuditEvent({
        db: tx,
        context,
        action: "sample.updated",
        resourceType: "sample",
        resourceId: sampleId,
        metadata: {
          experimentId: updated.experimentId,
          sampleKey: updated.sampleKey,
        },
        clientIp: options?.requestMetadata?.clientIp,
        userAgent: options?.requestMetadata?.userAgent,
      });

      return {
        id: updated.id,
        organizationId: updated.organizationId,
        experimentId: updated.experimentId,
        sampleKey: updated.sampleKey,
        displayName: updated.displayName,
        condition: updated.condition,
        batch: updated.batch,
        biologicalReplicate: updated.biologicalReplicate,
        technicalReplicate: updated.technicalReplicate,
        metadataJson: (updated.metadataJson ?? {}) as Record<string, unknown>,
      };
    });
  }
}

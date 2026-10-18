import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import type { TenantContext } from "@/types";
import { generateDomainId } from "@/lib/id";
import { getDb, type DbClient } from "../database/client";
import { experiments } from "../database/schema/experiments";
import { projects } from "../database/schema/projects";
import {
  ResourceNotFoundError,
  TenantAuthorizationError,
  ValidationError,
} from "../authorization/errors";
import { AuditService } from "./audit-service";
import { ProjectPermissionService } from "./project-permission-service";

export interface ExperimentDTO {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  description: string | null;
  organism: string | null;
  tissue: string | null;
  diseaseContext: string | null;
  createdBy: string;
  createdAt: Date;
}

export const createExperimentSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Experiment name is required")
    .max(255, "Experiment name cannot exceed 255 characters"),
  description: z
    .string()
    .trim()
    .max(2000, "Experiment description cannot exceed 2000 characters")
    .nullable()
    .optional(),
  organism: z
    .string()
    .trim()
    .max(100, "Organism cannot exceed 100 characters")
    .nullable()
    .optional(),
  tissue: z.string().trim().max(100, "Tissue cannot exceed 100 characters").nullable().optional(),
  diseaseContext: z
    .string()
    .trim()
    .max(100, "Disease context cannot exceed 100 characters")
    .nullable()
    .optional(),
});

export type CreateExperimentInput = z.infer<typeof createExperimentSchema>;

export const updateExperimentSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Experiment name cannot be empty")
    .max(255, "Experiment name cannot exceed 255 characters")
    .optional(),
  description: z
    .string()
    .trim()
    .max(2000, "Experiment description cannot exceed 2000 characters")
    .nullable()
    .optional(),
  organism: z
    .string()
    .trim()
    .max(100, "Organism cannot exceed 100 characters")
    .nullable()
    .optional(),
  tissue: z.string().trim().max(100, "Tissue cannot exceed 100 characters").nullable().optional(),
  diseaseContext: z
    .string()
    .trim()
    .max(100, "Disease context cannot exceed 100 characters")
    .nullable()
    .optional(),
});

export type UpdateExperimentInput = z.infer<typeof updateExperimentSchema>;

export interface ExperimentServiceOptions {
  dbClient?: DbClient;
  auditService?: AuditService;
  permissionService?: ProjectPermissionService;
}

/**
 * Experiment Application Service (Phase 2 Biological Experiment Boundary)
 *
 * Core Tenancy & Master Design Invariants:
 * 1. Strict Tenant Scoping: All operations execute within context.organizationId.
 * 2. Authorization & RBAC:
 *    - Asserts project access via ProjectPermissionService.assertProjectAccess(context, projectId).
 *    - Mutation operations (createExperiment, updateExperiment) require role in [owner, admin, bioinformatician, scientist].
 *    - Viewer role is strictly read-only.
 * 3. Archived Project Guard:
 *    - Mutations on experiments in archived projects are strictly rejected.
 * 4. Audit Logging:
 *    - Records experiment.created and experiment.updated.
 * 5. Identifiers:
 *    - Generates experiment IDs using centralized UUIDv7 generateDomainId("exp").
 */
export class ExperimentService {
  private readonly db: DbClient;
  private readonly auditService: AuditService;
  private readonly permissionService: ProjectPermissionService;

  constructor(options: ExperimentServiceOptions = {}) {
    this.db = options.dbClient ?? getDb();
    this.auditService = options.auditService ?? new AuditService({ dbClient: this.db });
    this.permissionService =
      options.permissionService ??
      new ProjectPermissionService({ dbClient: this.db, auditService: this.auditService });
  }

  private assertCanMutate(context: TenantContext): void {
    if (context.role === "viewer") {
      throw new TenantAuthorizationError("Viewer role is not authorized to modify experiments");
    }
  }

  /**
   * Creates an experiment inside an active project.
   */
  async createExperiment(
    context: TenantContext,
    projectId: string,
    input: CreateExperimentInput,
    options?: { requestMetadata?: { clientIp?: string | null; userAgent?: string | null } }
  ): Promise<ExperimentDTO> {
    this.assertCanMutate(context);
    await this.permissionService.assertProjectAccess(context, projectId);

    const parsed = createExperimentSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid experiment input");
    }

    const experimentId = generateDomainId("exp");
    const now = new Date();

    return await this.db.transaction(async (tx) => {
      // Verify parent project status
      const projectRows = await tx
        .select({ status: projects.status, archivedAt: projects.archivedAt })
        .from(projects)
        .where(
          and(eq(projects.id, projectId), eq(projects.organizationId, context.organizationId))
        );

      const parentProject = projectRows[0];
      if (!parentProject) {
        throw new ResourceNotFoundError("Project not found");
      }

      if (parentProject.status === "archived" || parentProject.archivedAt !== null) {
        throw new ValidationError("Cannot create experiments in an archived project");
      }

      const inserted = await tx
        .insert(experiments)
        .values({
          id: experimentId,
          organizationId: context.organizationId,
          projectId,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          organism: parsed.data.organism ?? null,
          tissue: parsed.data.tissue ?? null,
          diseaseContext: parsed.data.diseaseContext ?? null,
          createdBy: context.userId,
          createdAt: now,
        })
        .returning();

      const created = inserted[0];
      if (!created) {
        throw new Error("Failed to insert experiment record");
      }

      await this.auditService.recordUserAuditEvent({
        db: tx,
        context,
        action: "experiment.created",
        resourceType: "experiment",
        resourceId: experimentId,
        metadata: {
          projectId,
          name: created.name,
          organism: created.organism,
          tissue: created.tissue,
        },
        clientIp: options?.requestMetadata?.clientIp,
        userAgent: options?.requestMetadata?.userAgent,
        timestamp: now,
      });

      return {
        id: created.id,
        organizationId: created.organizationId,
        projectId: created.projectId,
        name: created.name,
        description: created.description,
        organism: created.organism,
        tissue: created.tissue,
        diseaseContext: created.diseaseContext,
        createdBy: created.createdBy,
        createdAt: created.createdAt,
      };
    });
  }

  /**
   * Retrieves an experiment by ID.
   */
  async getExperiment(context: TenantContext, experimentId: string): Promise<ExperimentDTO> {
    const rows = await this.db
      .select()
      .from(experiments)
      .where(
        and(
          eq(experiments.id, experimentId),
          eq(experiments.organizationId, context.organizationId)
        )
      );

    const record = rows[0];
    if (!record) {
      throw new ResourceNotFoundError("Experiment not found");
    }

    // Verify actor access to parent project
    await this.permissionService.assertProjectAccess(context, record.projectId);

    return {
      id: record.id,
      organizationId: record.organizationId,
      projectId: record.projectId,
      name: record.name,
      description: record.description,
      organism: record.organism,
      tissue: record.tissue,
      diseaseContext: record.diseaseContext,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
    };
  }

  /**
   * Lists experiments belonging to a project.
   */
  async listProjectExperiments(
    context: TenantContext,
    projectId: string
  ): Promise<ExperimentDTO[]> {
    await this.permissionService.assertProjectAccess(context, projectId);

    const rows = await this.db
      .select()
      .from(experiments)
      .where(
        and(
          eq(experiments.projectId, projectId),
          eq(experiments.organizationId, context.organizationId)
        )
      )
      .orderBy(desc(experiments.createdAt));

    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      projectId: r.projectId,
      name: r.name,
      description: r.description,
      organism: r.organism,
      tissue: r.tissue,
      diseaseContext: r.diseaseContext,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Updates an experiment's whitelisted metadata fields.
   */
  async updateExperiment(
    context: TenantContext,
    experimentId: string,
    input: UpdateExperimentInput,
    options?: { requestMetadata?: { clientIp?: string | null; userAgent?: string | null } }
  ): Promise<ExperimentDTO> {
    this.assertCanMutate(context);

    const parsed = updateExperimentSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? "Invalid experiment update payload"
      );
    }

    const { name, description, organism, tissue, diseaseContext } = parsed.data;
    if (
      name === undefined &&
      description === undefined &&
      organism === undefined &&
      tissue === undefined &&
      diseaseContext === undefined
    ) {
      throw new ValidationError("At least one field must be provided for update");
    }

    return await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(experiments)
        .where(
          and(
            eq(experiments.id, experimentId),
            eq(experiments.organizationId, context.organizationId)
          )
        );

      const existing = rows[0];
      if (!existing) {
        throw new ResourceNotFoundError("Experiment not found");
      }

      await this.permissionService.assertProjectAccess(context, existing.projectId);

      // Verify parent project is not archived
      const projectRows = await tx
        .select({ status: projects.status, archivedAt: projects.archivedAt })
        .from(projects)
        .where(
          and(
            eq(projects.id, existing.projectId),
            eq(projects.organizationId, context.organizationId)
          )
        );

      const parentProject = projectRows[0];
      if (
        !parentProject ||
        parentProject.status === "archived" ||
        parentProject.archivedAt !== null
      ) {
        throw new ValidationError("Cannot modify experiments in an archived project");
      }

      const updateValues: Partial<typeof experiments.$inferInsert> = {};
      if (name !== undefined) updateValues.name = name;
      if (description !== undefined) updateValues.description = description;
      if (organism !== undefined) updateValues.organism = organism;
      if (tissue !== undefined) updateValues.tissue = tissue;
      if (diseaseContext !== undefined) updateValues.diseaseContext = diseaseContext;

      const updatedRows = await tx
        .update(experiments)
        .set(updateValues)
        .where(
          and(
            eq(experiments.id, experimentId),
            eq(experiments.organizationId, context.organizationId)
          )
        )
        .returning();

      const updated = updatedRows[0];
      if (!updated) {
        throw new Error("Failed to update experiment");
      }

      await this.auditService.recordUserAuditEvent({
        db: tx,
        context,
        action: "experiment.updated",
        resourceType: "experiment",
        resourceId: experimentId,
        metadata: {
          projectId: updated.projectId,
          previousName: existing.name,
          updatedName: updated.name,
        },
        clientIp: options?.requestMetadata?.clientIp,
        userAgent: options?.requestMetadata?.userAgent,
      });

      return {
        id: updated.id,
        organizationId: updated.organizationId,
        projectId: updated.projectId,
        name: updated.name,
        description: updated.description,
        organism: updated.organism,
        tissue: updated.tissue,
        diseaseContext: updated.diseaseContext,
        createdBy: updated.createdBy,
        createdAt: updated.createdAt,
      };
    });
  }
}

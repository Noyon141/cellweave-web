import { eq, and, desc, sql } from "drizzle-orm";
import { z } from "zod";
import type { TenantContext } from "@/types";
import { generateDomainId } from "@/lib/id";
import { getDb, type DbClient } from "../database/client";
import { datasets, datasetVersions } from "../database/schema/datasets";
import { projects } from "../database/schema/projects";
import {
  ConflictError,
  ResourceNotFoundError,
  TenantAuthorizationError,
  ValidationError,
} from "../authorization/errors";
import { AuditService } from "./audit-service";
import { ProjectPermissionService } from "./project-permission-service";

export interface DatasetDTO {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  description: string | null;
  status: string;
  createdBy: string;
  createdAt: Date;
}

export interface DatasetVersionDTO {
  id: string;
  organizationId: string;
  datasetId: string;
  versionNumber: number;
  sourceFormat: string;
  canonicalFormat: string | null;
  organism: string | null;
  geneIdScheme: string | null;
  referenceBuild: string | null;
  cellCount: number | null;
  geneCount: number | null;
  sourceChecksum: string | null;
  canonicalChecksum: string | null;
  createdAt: Date;
}

export const createDatasetSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Dataset name is required")
    .max(255, "Dataset name cannot exceed 255 characters"),
  description: z
    .string()
    .trim()
    .max(2000, "Dataset description cannot exceed 2000 characters")
    .nullable()
    .optional(),
});

export type CreateDatasetInput = z.infer<typeof createDatasetSchema>;

export const createDatasetVersionSchema = z.object({
  sourceFormat: z
    .string()
    .trim()
    .min(1, "Source format is required")
    .max(50, "Source format cannot exceed 50 characters"),
  canonicalFormat: z.string().trim().max(50).nullable().optional(),
  organism: z.string().trim().max(100).nullable().optional(),
  geneIdScheme: z.string().trim().max(50).nullable().optional(),
  referenceBuild: z.string().trim().max(50).nullable().optional(),
  cellCount: z.number().int().nonnegative().nullable().optional(),
  geneCount: z.number().int().nonnegative().nullable().optional(),
  // Source checksum is established from persisted provenance by Phase 3, never by browser input.
  sourceChecksum: z.never().optional(),
  canonicalChecksum: z.string().trim().max(128).nullable().optional(),
});

export type CreateDatasetVersionInput = z.infer<typeof createDatasetVersionSchema>;

export interface DatasetServiceOptions {
  dbClient?: DbClient;
  auditService?: AuditService;
  permissionService?: ProjectPermissionService;
}

/**
 * Dataset Application Service (Phase 2 Logical Dataset & Immutable Version Boundary)
 *
 * Core Tenancy & Master Design Invariants:
 * 1. Strict Tenant Scoping: All queries & mutations filter by context.organizationId.
 * 2. Authorization & RBAC:
 *    - Asserts project access via ProjectPermissionService.assertProjectAccess(context, projectId).
 *    - Mutations (createDataset, createDatasetVersion) require role in [owner, admin, bioinformatician, scientist].
 *    - Viewer role is strictly read-only.
 * 3. Concurrency-Safe Version Number Allocation:
 *    - Executes inside one database transaction.
 *    - Row-locks the parent dataset row:
 *      SELECT ... FROM datasets WHERE id = ? AND organization_id = ? FOR UPDATE
 *    - Allocates next version monotonically:
 *      SELECT COALESCE(MAX(version_number), 0) + 1 FROM dataset_versions ...
 *    - Inserts new version row and records audit event in the same transaction.
 * 4. Immutability:
 *    - Dataset versions are immutable. No update or delete operations exist.
 * 5. Archived Project Guard:
 *    - Mutations on datasets in archived projects are strictly rejected.
 * 6. Audit Logging:
 *    - Records dataset.created and dataset_version.created.
 * 7. Identifiers:
 *    - Generates dataset IDs using generateDomainId("ds") and version IDs using generateDomainId("dsv").
 */
export class DatasetService {
  private readonly db: DbClient;
  private readonly auditService: AuditService;
  private readonly permissionService: ProjectPermissionService;

  constructor(options: DatasetServiceOptions = {}) {
    this.db = options.dbClient ?? getDb();
    this.auditService = options.auditService ?? new AuditService({ dbClient: this.db });
    this.permissionService =
      options.permissionService ??
      new ProjectPermissionService({ dbClient: this.db, auditService: this.auditService });
  }

  private assertCanMutate(context: TenantContext): void {
    if (context.role === "viewer") {
      throw new TenantAuthorizationError("Viewer role is not authorized to modify datasets");
    }
  }

  /**
   * Creates a logical dataset within a project.
   */
  async createDataset(
    context: TenantContext,
    projectId: string,
    input: CreateDatasetInput,
    options?: { requestMetadata?: { clientIp?: string | null; userAgent?: string | null } }
  ): Promise<DatasetDTO> {
    this.assertCanMutate(context);
    await this.permissionService.assertProjectAccess(context, projectId);

    const parsed = createDatasetSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid dataset input");
    }

    const datasetId = generateDomainId("ds");
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
        throw new ValidationError("Cannot create datasets in an archived project");
      }

      const inserted = await tx
        .insert(datasets)
        .values({
          id: datasetId,
          organizationId: context.organizationId,
          projectId,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          status: "active",
          createdBy: context.userId,
          createdAt: now,
        })
        .returning();

      const created = inserted[0];
      if (!created) {
        throw new Error("Failed to insert dataset record");
      }

      await this.auditService.recordUserAuditEvent({
        db: tx,
        context,
        action: "dataset.created",
        resourceType: "dataset",
        resourceId: datasetId,
        metadata: {
          projectId,
          name: created.name,
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
        status: created.status,
        createdBy: created.createdBy,
        createdAt: created.createdAt,
      };
    });
  }

  /**
   * Retrieves a dataset by ID.
   */
  async getDataset(context: TenantContext, datasetId: string): Promise<DatasetDTO> {
    const rows = await this.db
      .select()
      .from(datasets)
      .where(and(eq(datasets.id, datasetId), eq(datasets.organizationId, context.organizationId)));

    const record = rows[0];
    if (!record) {
      throw new ResourceNotFoundError("Dataset not found");
    }

    await this.permissionService.assertProjectAccess(context, record.projectId);

    return {
      id: record.id,
      organizationId: record.organizationId,
      projectId: record.projectId,
      name: record.name,
      description: record.description,
      status: record.status,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
    };
  }

  /**
   * Lists datasets belonging to a project.
   */
  async listProjectDatasets(context: TenantContext, projectId: string): Promise<DatasetDTO[]> {
    await this.permissionService.assertProjectAccess(context, projectId);

    const rows = await this.db
      .select()
      .from(datasets)
      .where(
        and(eq(datasets.projectId, projectId), eq(datasets.organizationId, context.organizationId))
      )
      .orderBy(desc(datasets.createdAt));

    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      projectId: r.projectId,
      name: r.name,
      description: r.description,
      status: r.status,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Creates a new immutable dataset version with concurrency-safe version number allocation.
   *
   * Transaction Algorithm:
   * 1. Check actor role in [owner, admin, bioinformatician, scientist].
   * 2. Begin transaction:
   *    a. SELECT parent dataset with FOR UPDATE to acquire exclusive row-lock on dataset.
   *    b. Assert project access and check parent project status != 'archived'.
   *    c. Query COALESCE(MAX(version_number), 0) + 1.
   *    d. INSERT dataset_version with next version number.
   *    e. Record dataset_version.created audit event atomically.
   */
  async createDatasetVersion(
    context: TenantContext,
    datasetId: string,
    input: CreateDatasetVersionInput,
    options?: { requestMetadata?: { clientIp?: string | null; userAgent?: string | null } }
  ): Promise<DatasetVersionDTO> {
    this.assertCanMutate(context);

    const parsed = createDatasetVersionSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid dataset version input");
    }

    const versionId = generateDomainId("dsv");
    const now = new Date();

    return await this.db.transaction(async (tx) => {
      // a. Exclusively lock parent dataset row for this transaction
      const datasetRows = await tx
        .select({
          id: datasets.id,
          projectId: datasets.projectId,
          status: datasets.status,
        })
        .from(datasets)
        .where(and(eq(datasets.id, datasetId), eq(datasets.organizationId, context.organizationId)))
        .for("update");

      const parentDataset = datasetRows[0];
      if (!parentDataset) {
        throw new ResourceNotFoundError("Dataset not found");
      }

      // b. Assert project access and verify parent project status
      await this.permissionService.assertProjectAccess(context, parentDataset.projectId);

      const projectRows = await tx
        .select({ status: projects.status, archivedAt: projects.archivedAt })
        .from(projects)
        .where(
          and(
            eq(projects.id, parentDataset.projectId),
            eq(projects.organizationId, context.organizationId)
          )
        );

      const parentProject = projectRows[0];
      if (
        !parentProject ||
        parentProject.status === "archived" ||
        parentProject.archivedAt !== null
      ) {
        throw new ValidationError("Cannot create dataset versions in an archived project");
      }

      // c. Calculate next monotonic version number for this dataset
      const maxVerResult = await tx
        .select({
          maxVersion: sql<number>`COALESCE(MAX(${datasetVersions.versionNumber}), 0)::integer`,
        })
        .from(datasetVersions)
        .where(
          and(
            eq(datasetVersions.datasetId, datasetId),
            eq(datasetVersions.organizationId, context.organizationId)
          )
        );

      const nextVersionNumber = (maxVerResult[0]?.maxVersion ?? 0) + 1;

      // d. Insert immutable version row
      let inserted;
      try {
        inserted = await tx
          .insert(datasetVersions)
          .values({
            id: versionId,
            organizationId: context.organizationId,
            datasetId,
            versionNumber: nextVersionNumber,
            sourceFormat: parsed.data.sourceFormat,
            canonicalFormat: parsed.data.canonicalFormat ?? null,
            organism: parsed.data.organism ?? null,
            geneIdScheme: parsed.data.geneIdScheme ?? null,
            referenceBuild: parsed.data.referenceBuild ?? null,
            cellCount: parsed.data.cellCount ?? null,
            geneCount: parsed.data.geneCount ?? null,
            sourceChecksum: null,
            canonicalChecksum: parsed.data.canonicalChecksum ?? null,
            createdAt: now,
          })
          .returning();
      } catch (err: unknown) {
        const error = err as { code?: string; message?: string };
        if (error.code === "23505") {
          throw new ConflictError(
            `Dataset version ${nextVersionNumber} already exists for dataset ${datasetId}`
          );
        }
        throw err;
      }

      const created = inserted[0];
      if (!created) {
        throw new Error("Failed to insert dataset version record");
      }

      // e. Record audit event atomically
      await this.auditService.recordUserAuditEvent({
        db: tx,
        context,
        action: "dataset_version.created",
        resourceType: "dataset_version",
        resourceId: versionId,
        metadata: {
          datasetId,
          versionNumber: created.versionNumber,
          sourceFormat: created.sourceFormat,
        },
        clientIp: options?.requestMetadata?.clientIp,
        userAgent: options?.requestMetadata?.userAgent,
        timestamp: now,
      });

      return {
        id: created.id,
        organizationId: created.organizationId,
        datasetId: created.datasetId,
        versionNumber: created.versionNumber,
        sourceFormat: created.sourceFormat,
        canonicalFormat: created.canonicalFormat,
        organism: created.organism,
        geneIdScheme: created.geneIdScheme,
        referenceBuild: created.referenceBuild,
        cellCount: created.cellCount,
        geneCount: created.geneCount,
        sourceChecksum: created.sourceChecksum,
        canonicalChecksum: created.canonicalChecksum,
        createdAt: created.createdAt,
      };
    });
  }

  /**
   * Lists all versions of a dataset ordered by version number ascending.
   */
  async listDatasetVersions(
    context: TenantContext,
    datasetId: string
  ): Promise<DatasetVersionDTO[]> {
    // 1. Resolve parent dataset and project to assert access
    const dsRows = await this.db
      .select({
        id: datasets.id,
        projectId: datasets.projectId,
      })
      .from(datasets)
      .where(and(eq(datasets.id, datasetId), eq(datasets.organizationId, context.organizationId)));

    const dataset = dsRows[0];
    if (!dataset) {
      throw new ResourceNotFoundError("Dataset not found");
    }

    await this.permissionService.assertProjectAccess(context, dataset.projectId);

    const rows = await this.db
      .select()
      .from(datasetVersions)
      .where(
        and(
          eq(datasetVersions.datasetId, datasetId),
          eq(datasetVersions.organizationId, context.organizationId)
        )
      )
      .orderBy(datasetVersions.versionNumber);

    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      datasetId: r.datasetId,
      versionNumber: r.versionNumber,
      sourceFormat: r.sourceFormat,
      canonicalFormat: r.canonicalFormat,
      organism: r.organism,
      geneIdScheme: r.geneIdScheme,
      referenceBuild: r.referenceBuild,
      cellCount: r.cellCount,
      geneCount: r.geneCount,
      sourceChecksum: r.sourceChecksum,
      canonicalChecksum: r.canonicalChecksum,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Retrieves a specific dataset version by ID.
   */
  async getDatasetVersion(context: TenantContext, versionId: string): Promise<DatasetVersionDTO> {
    const rows = await this.db
      .select({
        version: datasetVersions,
        projectId: datasets.projectId,
      })
      .from(datasetVersions)
      .innerJoin(
        datasets,
        and(
          eq(datasetVersions.datasetId, datasets.id),
          eq(datasetVersions.organizationId, datasets.organizationId)
        )
      )
      .where(
        and(
          eq(datasetVersions.id, versionId),
          eq(datasetVersions.organizationId, context.organizationId)
        )
      );

    const record = rows[0];
    if (!record) {
      throw new ResourceNotFoundError("Dataset version not found");
    }

    await this.permissionService.assertProjectAccess(context, record.projectId);

    const r = record.version;
    return {
      id: r.id,
      organizationId: r.organizationId,
      datasetId: r.datasetId,
      versionNumber: r.versionNumber,
      sourceFormat: r.sourceFormat,
      canonicalFormat: r.canonicalFormat,
      organism: r.organism,
      geneIdScheme: r.geneIdScheme,
      referenceBuild: r.referenceBuild,
      cellCount: r.cellCount,
      geneCount: r.geneCount,
      sourceChecksum: r.sourceChecksum,
      canonicalChecksum: r.canonicalChecksum,
      createdAt: r.createdAt,
    };
  }
}

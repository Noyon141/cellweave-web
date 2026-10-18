import { eq, and, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TenantContext } from "@/types";
import { getDb, type DbClient } from "../database/client";
import { projects, projectMembers } from "../database/schema/projects";
import { assertOrgAdmin } from "../authorization/guards";
import { ResourceNotFoundError, ValidationError } from "../authorization/errors";
import { AuditService } from "./audit-service";
import { ProjectPermissionService } from "./project-permission-service";

export interface ProjectDTO {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  status: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export const createProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Project name is required")
    .max(255, "Project name cannot exceed 255 characters"),
  description: z
    .string()
    .trim()
    .max(2000, "Project description cannot exceed 2000 characters")
    .nullable()
    .optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Project name cannot be empty")
    .max(255, "Project name cannot exceed 255 characters")
    .optional(),
  description: z
    .string()
    .trim()
    .max(2000, "Project description cannot exceed 2000 characters")
    .nullable()
    .optional(),
});

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export interface ProjectServiceOptions {
  dbClient?: DbClient;
  auditService?: AuditService;
  permissionService?: ProjectPermissionService;
}

/**
 * Project Application Service (Phase 2 Project Foundation)
 *
 * Core Tenancy & Master Design Invariants:
 * 1. Strict Tenant Scoping: Every query and mutation is filtered by context.organizationId.
 * 2. Role Authorization Matrix:
 *    - createProject: owner, admin only.
 *    - updateProject: owner, admin only.
 *    - archiveProject: owner, admin only.
 *    - getProject: owner, admin (all org projects); bioinformatician, scientist, viewer (assigned only).
 *    - listAccessibleProjects: owner, admin see all; lower roles see only assigned projects.
 * 3. Inactive/Archived Projects:
 *    - Readable to permitted users.
 *    - Archived projects cannot be updated or re-archived.
 * 4. Audit Logging:
 *    - Records project.created, project.updated, project.archived.
 * 5. Identifiers:
 *    - Generates project IDs using prj_<uuid_no_hyphens> (preserving Phase 1 pattern).
 */
export class ProjectService {
  private readonly db: DbClient;
  private readonly auditService: AuditService;
  private readonly permissionService: ProjectPermissionService;

  constructor(options: ProjectServiceOptions = {}) {
    this.db = options.dbClient ?? getDb();
    this.auditService = options.auditService ?? new AuditService({ dbClient: this.db });
    this.permissionService =
      options.permissionService ??
      new ProjectPermissionService({ dbClient: this.db, auditService: this.auditService });
  }

  /**
   * Creates a new project in the active tenant.
   * Only owner and admin roles may create projects.
   */
  async createProject(
    context: TenantContext,
    input: CreateProjectInput,
    options?: { requestMetadata?: { clientIp?: string | null; userAgent?: string | null } }
  ): Promise<ProjectDTO> {
    assertOrgAdmin(context);

    const parsed = createProjectSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid project input");
    }

    const projectId = `prj_${randomUUID().replace(/-/g, "")}`;
    const now = new Date();

    return await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(projects)
        .values({
          id: projectId,
          organizationId: context.organizationId,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          status: "active",
          createdBy: context.userId,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        })
        .returning();

      const created = inserted[0];
      if (!created) {
        throw new Error("Failed to insert project record");
      }

      await this.auditService.recordUserAuditEvent({
        db: tx,
        context,
        action: "project.created",
        resourceType: "project",
        resourceId: projectId,
        metadata: {
          name: created.name,
          description: created.description,
        },
        clientIp: options?.requestMetadata?.clientIp,
        userAgent: options?.requestMetadata?.userAgent,
        timestamp: now,
      });

      return {
        id: created.id,
        organizationId: created.organizationId,
        name: created.name,
        description: created.description,
        status: created.status,
        createdBy: created.createdBy,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        archivedAt: created.archivedAt,
      };
    });
  }

  /**
   * Retrieves a project by ID with tenant and access assertions.
   * Owner and Admin have org-wide access.
   * Bioinformatician, Scientist, and Viewer require explicit project assignment.
   */
  async getProject(context: TenantContext, projectId: string): Promise<ProjectDTO> {
    await this.permissionService.assertProjectAccess(context, projectId);

    const rows = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, context.organizationId)));

    const record = rows[0];
    if (!record) {
      throw new ResourceNotFoundError("Project not found");
    }

    return {
      id: record.id,
      organizationId: record.organizationId,
      name: record.name,
      description: record.description,
      status: record.status,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      archivedAt: record.archivedAt,
    };
  }

  /**
   * Lists projects accessible to the actor within the tenant context.
   * Owner and Admin see all organization projects.
   * Bioinformatician, Scientist, and Viewer see only assigned projects.
   */
  async listAccessibleProjects(
    context: TenantContext,
    options?: { includeArchived?: boolean }
  ): Promise<ProjectDTO[]> {
    const includeArchived = options?.includeArchived ?? false;

    if (context.role === "owner" || context.role === "admin") {
      let query = this.db
        .select()
        .from(projects)
        .where(
          includeArchived
            ? eq(projects.organizationId, context.organizationId)
            : and(
                eq(projects.organizationId, context.organizationId),
                eq(projects.status, "active")
              )
        )
        .orderBy(desc(projects.createdAt));

      const rows = await query;
      return rows.map((r) => ({
        id: r.id,
        organizationId: r.organizationId,
        name: r.name,
        description: r.description,
        status: r.status,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        archivedAt: r.archivedAt,
      }));
    }

    // Lower roles: Inner join with projectMembers for context.userId
    const rows = await this.db
      .select({
        project: projects,
      })
      .from(projects)
      .innerJoin(
        projectMembers,
        and(
          eq(projects.id, projectMembers.projectId),
          eq(projects.organizationId, projectMembers.organizationId),
          eq(projectMembers.userId, context.userId)
        )
      )
      .where(
        includeArchived
          ? eq(projects.organizationId, context.organizationId)
          : and(eq(projects.organizationId, context.organizationId), eq(projects.status, "active"))
      )
      .orderBy(desc(projects.createdAt));

    return rows.map(({ project: r }) => ({
      id: r.id,
      organizationId: r.organizationId,
      name: r.name,
      description: r.description,
      status: r.status,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      archivedAt: r.archivedAt,
    }));
  }

  /**
   * Updates an active project's metadata.
   * Only owner and admin roles may update projects.
   * Rejects updates if the project is archived.
   */
  async updateProject(
    context: TenantContext,
    projectId: string,
    input: UpdateProjectInput,
    options?: { requestMetadata?: { clientIp?: string | null; userAgent?: string | null } }
  ): Promise<ProjectDTO> {
    assertOrgAdmin(context);

    const parsed = updateProjectSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues[0]?.message ?? "Invalid project update payload"
      );
    }

    if (parsed.data.name === undefined && parsed.data.description === undefined) {
      throw new ValidationError(
        "At least one field (name or description) must be provided for update"
      );
    }

    const now = new Date();

    return await this.db.transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(projects)
        .where(
          and(eq(projects.id, projectId), eq(projects.organizationId, context.organizationId))
        );

      const existing = existingRows[0];
      if (!existing) {
        throw new ResourceNotFoundError("Project not found");
      }

      if (existing.status === "archived" || existing.archivedAt !== null) {
        throw new ValidationError("Cannot modify an archived project");
      }

      const updateValues: Partial<typeof projects.$inferInsert> = {
        updatedAt: now,
      };

      if (parsed.data.name !== undefined) {
        updateValues.name = parsed.data.name;
      }
      if (parsed.data.description !== undefined) {
        updateValues.description = parsed.data.description;
      }

      const updatedRows = await tx
        .update(projects)
        .set(updateValues)
        .where(and(eq(projects.id, projectId), eq(projects.organizationId, context.organizationId)))
        .returning();

      const updated = updatedRows[0];
      if (!updated) {
        throw new Error("Failed to update project");
      }

      await this.auditService.recordUserAuditEvent({
        db: tx,
        context,
        action: "project.updated",
        resourceType: "project",
        resourceId: projectId,
        metadata: {
          previousName: existing.name,
          updatedName: updated.name,
          updatedDescription: updated.description,
        },
        clientIp: options?.requestMetadata?.clientIp,
        userAgent: options?.requestMetadata?.userAgent,
        timestamp: now,
      });

      return {
        id: updated.id,
        organizationId: updated.organizationId,
        name: updated.name,
        description: updated.description,
        status: updated.status,
        createdBy: updated.createdBy,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        archivedAt: updated.archivedAt,
      };
    });
  }

  /**
   * Archives a project.
   * Only owner and admin roles may archive projects.
   * Rejects if already archived.
   */
  async archiveProject(
    context: TenantContext,
    projectId: string,
    options?: { requestMetadata?: { clientIp?: string | null; userAgent?: string | null } }
  ): Promise<ProjectDTO> {
    assertOrgAdmin(context);

    const now = new Date();

    return await this.db.transaction(async (tx) => {
      const existingRows = await tx
        .select()
        .from(projects)
        .where(
          and(eq(projects.id, projectId), eq(projects.organizationId, context.organizationId))
        );

      const existing = existingRows[0];
      if (!existing) {
        throw new ResourceNotFoundError("Project not found");
      }

      if (existing.status === "archived" || existing.archivedAt !== null) {
        throw new ValidationError("Project is already archived");
      }

      const updatedRows = await tx
        .update(projects)
        .set({
          status: "archived",
          archivedAt: now,
          updatedAt: now,
        })
        .where(and(eq(projects.id, projectId), eq(projects.organizationId, context.organizationId)))
        .returning();

      const archived = updatedRows[0];
      if (!archived) {
        throw new Error("Failed to archive project");
      }

      await this.auditService.recordUserAuditEvent({
        db: tx,
        context,
        action: "project.archived",
        resourceType: "project",
        resourceId: projectId,
        metadata: {
          name: archived.name,
          archivedAt: now.toISOString(),
        },
        clientIp: options?.requestMetadata?.clientIp,
        userAgent: options?.requestMetadata?.userAgent,
        timestamp: now,
      });

      return {
        id: archived.id,
        organizationId: archived.organizationId,
        name: archived.name,
        description: archived.description,
        status: archived.status,
        createdBy: archived.createdBy,
        createdAt: archived.createdAt,
        updatedAt: archived.updatedAt,
        archivedAt: archived.archivedAt,
      };
    });
  }
}

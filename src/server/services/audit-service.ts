import { eq, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { TenantContext } from "@/types";
import { getDb, type DbClient } from "../database/client";
import { auditEvents } from "../database/schema/audit-events";
import { assertOwner } from "../authorization/guards";
import { validateTenantAccess } from "../authorization";
import { hashIpAddress, sanitizeAuditMetadata } from "./audit-privacy";

/**
 * Step H Audit Event Persistence Input
 */
export interface RecordAuditEventInput {
  /**
   * Optional TenantContext for authenticated user actions.
   * If provided, organizationId, actorId, and actorType are strictly derived from context.
   */
  context?: TenantContext;
  /**
   * For explicit non-user / system actions (when context is not present).
   */
  explicitScope?: {
    organizationId: string;
    actorType: string;
    actorId: string;
  };
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown> | null;
  clientIp?: string | null;
  userAgent?: string | null;
  timestamp?: Date;
}

export interface AuditEventDTO {
  id: string;
  organizationId: string;
  actorType: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown> | null;
  ipHash: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface ListAuditEventsOptions {
  limit?: number;
  offset?: number;
}

export interface AuditServiceOptions {
  dbClient?: DbClient;
}

/**
 * Audit Application Service (Phase 1 Identity, Tenancy & Governance)
 *
 * Master Design & Architecture Invariants:
 * 1. Append-Only: Exposes only recordAuditEvent (INSERT) and listAuditEvents (SELECT).
 *    No UPDATE or DELETE methods exist.
 * 2. Actor Derivation: For authenticated actions, organizationId, actorId, and actorType ("user")
 *    are strictly derived from TenantContext. Never accepted from untrusted request payloads.
 * 3. Privacy & RUO Invariants:
 *    - Never logs raw IP addresses (hashes via keyed HMAC).
 *    - Defensive sanitization rejects passwords, secrets, tokens, matrices, gene vectors, and PHI.
 * 4. Read Authorization:
 *    - Owner-only: Only organization owners may read audit logs.
 *    - All queries are strictly scoped by TenantContext.organizationId.
 */
export class AuditService {
  private readonly db: DbClient;

  constructor(options: AuditServiceOptions = {}) {
    this.db = options.dbClient ?? getDb();
  }

  /**
   * Persists an immutable audit event to the database.
   * Append-only: INSERT ONLY.
   */
  async recordAuditEvent(input: RecordAuditEventInput): Promise<AuditEventDTO> {
    let orgId: string;
    let actorType: string;
    let actorId: string;

    if (input.context) {
      orgId = input.context.organizationId;
      actorType = "user";
      actorId = input.context.userId;
    } else if (input.explicitScope) {
      orgId = input.explicitScope.organizationId;
      actorType = input.explicitScope.actorType;
      actorId = input.explicitScope.actorId;
    } else {
      throw new Error("Audit event requires either TenantContext or explicitScope");
    }

    // Privacy & Sanitization
    const sanitizedMetadata = sanitizeAuditMetadata(input.metadata);
    const ipHash = hashIpAddress(input.clientIp);
    const eventId = `aud_${randomUUID()}`;
    const createdAt = input.timestamp ?? new Date();

    const eventRecord = {
      id: eventId,
      organizationId: orgId,
      actorType,
      actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: sanitizedMetadata,
      ipHash,
      userAgent: input.userAgent ?? null,
      createdAt,
    };

    // Execute INSERT
    await this.db.insert(auditEvents).values(eventRecord);

    return {
      ...eventRecord,
      metadata: sanitizedMetadata,
    };
  }

  /**
   * Lists audit events for the active tenant.
   *
   * Authorization:
   * - Owner only: assertOwner(context).
   * - Scoped strictly to context.organizationId.
   * - Ordered newest-first (createdAt DESC).
   * - Bounded pagination (default 50, maximum 100).
   */
  async listAuditEvents(
    context: TenantContext,
    targetOrganizationId: string,
    options: ListAuditEventsOptions = {}
  ): Promise<AuditEventDTO[]> {
    validateTenantAccess(context, targetOrganizationId);
    assertOwner(context);

    const safeLimit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const safeOffset = Math.max(options.offset ?? 0, 0);

    const rows = await this.db
      .select({
        id: auditEvents.id,
        organizationId: auditEvents.organizationId,
        actorType: auditEvents.actorType,
        actorId: auditEvents.actorId,
        action: auditEvents.action,
        resourceType: auditEvents.resourceType,
        resourceId: auditEvents.resourceId,
        metadata: auditEvents.metadata,
        ipHash: auditEvents.ipHash,
        userAgent: auditEvents.userAgent,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, context.organizationId))
      .orderBy(desc(auditEvents.createdAt))
      .limit(safeLimit)
      .offset(safeOffset);

    return rows.map((r) => ({
      ...r,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    }));
  }
}

import { describe, it, expect, vi } from "vitest";
import { handleRouteError } from "@/server/api/error-handler";
import { extractRequestAuditMetadata } from "@/server/api/request-metadata";
import {
  TenantAuthorizationError,
  ResourceNotFoundError,
  ValidationError,
  validateTenantAccess,
} from "@/server/authorization";
import type { TenantContext } from "@/types";
import { AuditService } from "@/server/services/audit-service";
import { hashIpAddress, sanitizeAuditMetadata } from "@/server/services/audit-privacy";
import { getHealthService } from "@/server/application/health-service";
import type { DbClient } from "@/server/database/client";

describe("Phase 1 Step I-B: Error Non-Disclosure & Audit Metadata Wiring (Items 1-13)", () => {
  const activeOrgId = "org_active_test_11111";
  const foreignOrgId = "org_foreign_test_99999";
  const testUserId = "usr_tester_12345";

  const ownerContext: TenantContext = Object.freeze({
    organizationId: activeOrgId,
    userId: testUserId,
    role: "owner",
  });

  // 1. cross-tenant HTTP response contains generic message only
  it("1. cross-tenant HTTP response contains generic message only", async () => {
    let thrownError: unknown;
    try {
      validateTenantAccess(ownerContext, foreignOrgId);
    } catch (err) {
      thrownError = err;
    }

    const response = handleRouteError(thrownError);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "FORBIDDEN",
      message: "You are not authorized to access this resource.",
    });
  });

  // 2. active organizationId is not serialized in cross-tenant error
  it("2. active organizationId is not serialized in cross-tenant error", async () => {
    let thrownError: unknown;
    try {
      validateTenantAccess(ownerContext, foreignOrgId);
    } catch (err) {
      thrownError = err;
    }

    const response = handleRouteError(thrownError);
    const text = await response.text();
    expect(text).not.toContain(activeOrgId);
  });

  // 3. target organizationId is not serialized
  it("3. target organizationId is not serialized", async () => {
    let thrownError: unknown;
    try {
      validateTenantAccess(ownerContext, foreignOrgId);
    } catch (err) {
      thrownError = err;
    }

    const response = handleRouteError(thrownError);
    const text = await response.text();
    expect(text).not.toContain(foreignOrgId);
  });

  // 4. foreign member error does not disclose tenant details
  it("4. foreign member error does not disclose tenant details", async () => {
    // Both not-found and cross-tenant member access return non-disclosing responses
    const notFoundError = new ResourceNotFoundError("Member not found in organization");
    const response404 = handleRouteError(notFoundError);
    expect(response404.status).toBe(404);
    const body404 = (await response404.json()) as { error: string; message: string };
    expect(body404).toEqual({
      error: "NOT_FOUND",
      message: "Resource not found",
    });
    expect(JSON.stringify(body404)).not.toContain("Member not found in organization");

    // Cross-tenant attempt
    const crossTenantError = new TenantAuthorizationError("Cross-tenant access prohibited");
    const response403 = handleRouteError(crossTenantError);
    expect(response403.status).toBe(403);
    const body403 = (await response403.json()) as { error: string; message: string };
    expect(body403).toEqual({
      error: "FORBIDDEN",
      message: "You are not authorized to access this resource.",
    });
  });

  // 5. foreign invitation error does not disclose tenant details
  it("5. foreign invitation error does not disclose tenant details", async () => {
    const notFoundError = new ResourceNotFoundError("Invitation not found in organization");
    const response404 = handleRouteError(notFoundError);
    expect(response404.status).toBe(404);
    const body404 = (await response404.json()) as { error: string; message: string };
    expect(body404).toEqual({
      error: "NOT_FOUND",
      message: "Resource not found",
    });
    expect(JSON.stringify(body404)).not.toContain("Invitation not found");
  });

  // 6. foreign project error does not disclose tenant details
  it("6. foreign project error does not disclose tenant details", async () => {
    const notFoundError = new ResourceNotFoundError("Project not found");
    const response404 = handleRouteError(notFoundError);
    expect(response404.status).toBe(404);
    const body404 = (await response404.json()) as { error: string; message: string };
    expect(body404).toEqual({
      error: "NOT_FOUND",
      message: "Resource not found",
    });
    expect(JSON.stringify(body404)).not.toContain("Project not found");
  });

  // 7. audit route cross-tenant response does not disclose identifiers
  it("7. audit route cross-tenant response does not disclose identifiers", async () => {
    const mockDb = {
      select: vi.fn(),
    } as unknown as DbClient;
    const auditService = new AuditService({ dbClient: mockDb });

    let thrownError: unknown;
    try {
      await auditService.listAuditEvents(ownerContext, foreignOrgId);
    } catch (err) {
      thrownError = err;
    }

    const response = handleRouteError(thrownError);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; message: string };
    expect(body).toEqual({
      error: "FORBIDDEN",
      message: "You are not authorized to access this resource.",
    });
    expect(JSON.stringify(body)).not.toContain(foreignOrgId);
    expect(JSON.stringify(body)).not.toContain(activeOrgId);
  });

  // 8. request User-Agent reaches audit record when supplied
  it("8. request User-Agent reaches audit record when supplied", async () => {
    const testUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) CellWeaveDev/1.0";
    const req = new Request("https://dev.cellweave.app/api/v1/organizations/org_123/settings", {
      headers: {
        "user-agent": testUA,
      },
    });

    const meta = extractRequestAuditMetadata(req);
    expect(meta.userAgent).toBe(testUA);

    // Verify it passes into recordUserAuditEvent
    let insertedRecord: Record<string, unknown> | null = null;
    const mockDb = {
      insert: (_table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          insertedRecord = vals;
          return Promise.resolve();
        },
      }),
    } as unknown as DbClient;

    const auditService = new AuditService({ dbClient: mockDb });
    await auditService.recordUserAuditEvent({
      context: ownerContext,
      action: "test.action",
      resourceType: "organization",
      resourceId: activeOrgId,
      userAgent: meta.userAgent,
    });

    expect(insertedRecord).not.toBeNull();
    if (!insertedRecord) {
      throw new Error("Expected audit record to be inserted");
    }
    const record: Record<string, unknown> = insertedRecord;
    expect(record.userAgent).toBe(testUA);
  });

  // 9. raw IP is never persisted
  it("9. raw IP is never persisted", async () => {
    const rawIp = "198.51.100.42";
    let insertedRecord: Record<string, unknown> | null = null;
    const mockDb = {
      insert: (_table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          insertedRecord = vals;
          return Promise.resolve();
        },
      }),
    } as unknown as DbClient;

    const auditService = new AuditService({ dbClient: mockDb });
    await auditService.recordUserAuditEvent({
      context: ownerContext,
      action: "test.ip_check",
      resourceType: "organization",
      resourceId: activeOrgId,
      clientIp: rawIp,
      metadata: { key: "value" },
    });

    expect(insertedRecord).not.toBeNull();
    if (!insertedRecord) {
      throw new Error("Expected audit record to be inserted");
    }
    const record: Record<string, unknown> = insertedRecord;
    // Raw IP must not be in any top-level column
    expect(record.clientIp).toBeUndefined();
    expect(record.ip).toBeUndefined();
    expect(record.ipHash).not.toBe(rawIp);
    // Raw IP must not be in metadata
    expect(JSON.stringify(record.metadata)).not.toContain(rawIp);
    // Raw IP must not appear anywhere in the serialized record
    expect(JSON.stringify(record)).not.toContain(rawIp);
  });

  // 10. trusted request IP produces only ipHash
  it("10. trusted request IP produces only ipHash", async () => {
    const trustedIp = "203.0.113.195";

    // Test extraction from x-real-ip
    const reqWithRealIp = new Request("https://dev.cellweave.app/api/v1/test", {
      headers: {
        "x-real-ip": trustedIp,
      },
    });
    const meta1 = extractRequestAuditMetadata(reqWithRealIp);
    expect(meta1.clientIp).toBe(trustedIp);

    // Test extraction from x-vercel-forwarded-for
    const reqWithVercelFwd = new Request("https://dev.cellweave.app/api/v1/test", {
      headers: {
        "x-vercel-forwarded-for": `${trustedIp}, 10.0.0.1`,
      },
    });
    const meta2 = extractRequestAuditMetadata(reqWithVercelFwd);
    expect(meta2.clientIp).toBe(trustedIp);

    // Test hashing produces deterministic HMAC
    const expectedHash = hashIpAddress(trustedIp);
    expect(expectedHash).toBeDefined();
    expect(expectedHash).toHaveLength(64); // SHA-256 hex string

    let insertedRecord: Record<string, unknown> | null = null;
    const mockDb = {
      insert: (_table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          insertedRecord = vals;
          return Promise.resolve();
        },
      }),
    } as unknown as DbClient;

    const auditService = new AuditService({ dbClient: mockDb });
    await auditService.recordUserAuditEvent({
      context: ownerContext,
      action: "test.ip_hash",
      resourceType: "organization",
      resourceId: activeOrgId,
      clientIp: meta1.clientIp,
    });

    expect(insertedRecord).not.toBeNull();
    if (!insertedRecord) {
      throw new Error("Expected audit record to be inserted");
    }
    const record10: Record<string, unknown> = insertedRecord;
    expect(record10.ipHash).toBe(expectedHash);
  });

  // 11. missing/untrusted IP safely results in null ipHash
  it("11. missing/untrusted IP safely results in null ipHash", async () => {
    // Request with untrusted x-forwarded-for ONLY (no x-real-ip, no x-vercel-forwarded-for)
    const untrustedReq = new Request("https://dev.cellweave.app/api/v1/test", {
      headers: {
        "x-forwarded-for": "1.2.3.4, 5.6.7.8",
      },
    });
    const meta = extractRequestAuditMetadata(untrustedReq);
    expect(meta.clientIp).toBeNull();

    let insertedRecord: Record<string, unknown> | null = null;
    const mockDb = {
      insert: (_table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          insertedRecord = vals;
          return Promise.resolve();
        },
      }),
    } as unknown as DbClient;

    const auditService = new AuditService({ dbClient: mockDb });
    await auditService.recordUserAuditEvent({
      context: ownerContext,
      action: "test.no_ip",
      resourceType: "organization",
      resourceId: activeOrgId,
      clientIp: meta.clientIp,
    });

    expect(insertedRecord).not.toBeNull();
    if (!insertedRecord) {
      throw new Error("Expected audit record to be inserted");
    }
    const record11: Record<string, unknown> = insertedRecord;
    expect(record11.ipHash).toBeNull();
  });

  // 12. existing HMAC/privacy tests remain passing
  it("12. existing HMAC/privacy tests remain passing", () => {
    // Null / empty IP returns null
    expect(hashIpAddress(null)).toBeNull();
    expect(hashIpAddress(undefined)).toBeNull();
    expect(hashIpAddress("")).toBeNull();
    expect(hashIpAddress("   ")).toBeNull();

    // Valid IP produces non-empty hash
    const hash = hashIpAddress("127.0.0.1");
    expect(hash).not.toBeNull();
    expect(typeof hash).toBe("string");

    // Key rotation sensitivity
    const hashKeyA = hashIpAddress("127.0.0.1", "secret-key-a");
    const hashKeyB = hashIpAddress("127.0.0.1", "secret-key-b");
    expect(hashKeyA).not.toBe(hashKeyB);

    // Sanitization rejects forbidden keys
    expect(() => sanitizeAuditMetadata({ password: "123" })).toThrow(ValidationError);
    expect(() => sanitizeAuditMetadata({ secretToken: "abc" })).toThrow(ValidationError);
    expect(() => sanitizeAuditMetadata({ geneExpressionMatrix: [] })).toThrow(ValidationError);
    expect(() => sanitizeAuditMetadata({ phiPatientId: "pid-1" })).toThrow(ValidationError);
  });

  // 13. health route no longer reports stale Phase 0 metadata
  it("13. health route no longer reports stale Phase 0 metadata", async () => {
    const healthService = getHealthService();
    const status = await healthService.getHealthStatus();

    expect(status.phase).toBe("Phase 1 — Identity & Tenancy");
    expect(status.phase).not.toBe("Phase 0 — Foundations");
  });
});

import { beforeEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { TenantAuthorizationError } from "@/server/authorization/errors";
const fake = vi.hoisted(() => ({
  tenant: vi.fn(),
  verify: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  register: vi.fn(),
}));
vi.mock("@/server/authorization", () => ({ resolveTenantContext: fake.tenant }));
vi.mock("@/server/authorization/service-token", () => ({
  getServiceTokenVerifier: async () => ({ verify: fake.verify }),
  ServiceAuthenticationError: class extends Error {},
  ServiceVerificationConfigurationError: class extends Error {},
}));
vi.mock("@/server/services/qc-service", () => ({
  QcService: class {
    async create(...args: unknown[]) {
      return fake.create(...args);
    }
    async approve(...args: unknown[]) {
      return fake.approve(...args);
    }
    async register(...args: unknown[]) {
      return fake.register(...args);
    }
  },
}));
import { POST as create } from "@/app/api/v1/qc/route";
import { POST as operation } from "@/app/api/v1/qc/[runId]/[operation]/route";
import { POST as internal } from "@/app/api/internal/qc/[runId]/[operation]/route";
const context = { organizationId: "trusted-org", userId: "human", role: "scientist" as const };
const request = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/qc", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "stable" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  fake.tenant.mockResolvedValue(context);
  fake.verify.mockResolvedValue({
    subject: "cellweave-orchestrator",
    scopes: ["execution.finalize"],
  });
});
describe("thin QC routes", () => {
  it("resolves customer identity before creating a bounded application request", async () => {
    const input = { datasetVersionId: "dsv", captureBindings: [], wholeInputSampleId: null };
    fake.create.mockResolvedValue({ analysisRunId: "run" });
    expect((await create(request(input))).status).toBe(202);
    expect(fake.create).toHaveBeenCalledWith(context, input, "stable");
  });
  it("does not invoke application services for unauthorized customers", async () => {
    fake.tenant.mockRejectedValue(new TenantAuthorizationError("Unavailable"));
    expect((await create(request({}))).status).toBe(403);
    expect(fake.create).not.toHaveBeenCalled();
  });
  it("uses the persisted customer context for human confirmation", async () => {
    fake.approve.mockResolvedValue({ id: "qcd" });
    const input = { previewId: "preview", reason: "Reviewed" };
    expect(
      (
        await operation(request(input), {
          params: Promise.resolve({ runId: "run", operation: "approve" }),
        })
      ).status
    ).toBe(200);
    expect(fake.approve).toHaveBeenCalledWith(context, "run", input, "stable");
  });
  it("requires finalization scope before scientific artifact registration", async () => {
    fake.register.mockResolvedValue({ registered: true });
    expect(
      (
        await internal(request({}), {
          params: Promise.resolve({ runId: "run", operation: "register" }),
        })
      ).status
    ).toBe(200);
    expect(fake.verify).toHaveBeenCalledWith(null, ["execution.finalize"]);
  });
  it("rejects oversized payloads without invoking application logic", async () => {
    expect((await create(request({ padding: "x".repeat(1024 * 1024 + 1) }))).status).toBe(400);
    expect(fake.create).not.toHaveBeenCalled();
  });
});

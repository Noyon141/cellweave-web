import { beforeEach, describe, it, expect, vi } from "vitest";
import type { DbClient } from "@/server/database/client";
import { analysisRuns, workflowSteps } from "@/server/database/schema";
import { ExecutionService, createExecutionSchema } from "@/server/services/execution-service";
import { createServiceTokenVerifier } from "@/server/authorization/service-token";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
const mocks = vi.hoisted(() => ({ start: vi.fn(), events: [] as string[] }));
vi.mock("@/server/integrations/temporal/client", () => ({
  getTemporalClientService: () => ({
    getClient: async () => ({ workflow: { start: mocks.start } }),
  }),
}));
vi.mock("@/server/services/project-permission-service", () => ({
  ProjectPermissionService: class {
    async assertProjectAccess() {
      return;
    }
  },
}));
vi.mock("@/server/integrations/auth/better-auth", () => ({ auth: { api: {} } }));
const context = { organizationId: "trusted-org", userId: "user", role: "scientist" as const };
const request = {
  datasetVersionId: "dsv",
  pipelineVersion: "approved-import",
  organism: "HUMAN",
  geneIdScheme: "ENSEMBL",
  referenceBuild: null,
};
beforeEach(() => {
  vi.stubEnv("SERVICE_AUTH_ENVIRONMENT", "development");
  mocks.start.mockReset();
  mocks.events.length = 0;
  vi.stubEnv("EXECUTION_PIPELINE_VERSION", "approved-import");
  vi.stubEnv("TEMPORAL_TASK_QUEUE", "cellweave-analysis-queue");
  vi.stubEnv(
    "EXECUTION_CEILINGS_JSON",
    JSON.stringify({
      resourceClass: "CPU_SMALL",
      estimatedComputeUnits: 1,
      maxComputeUnits: 10,
      maxRuntimeSeconds: 60,
      maxMemoryClass: "CPU_SMALL",
      maxInputBytes: 1000,
      maxDecompressedBytes: 10000,
      maxCompressionRatio: 10,
    })
  );
});
function database() {
  let run: Record<string, unknown> | undefined;
  let step: Record<string, unknown> | undefined;
  const insert = vi.fn((table: unknown) => ({
    values: (value: Record<string, unknown>) => {
      if (table === analysisRuns) run = value;
      if (table === workflowSteps) step = value;
      return Object.assign(Promise.resolve(), {
        onConflictDoNothing: () => ({
          returning: async () => [{ id: value.id, workflowId: value.temporalWorkflowId }],
        }),
      });
    },
  }));
  const db = {
    select: (shape?: unknown) => ({
      from: (table: unknown) => {
        const query = {
          innerJoin: () => query,
          where: async () => {
            if (table === analysisRuns)
              return run
                ? shape
                  ? [
                      {
                        run: { ...run, projectionVersion: 0, cancelRequested: false },
                        step: { ...step, providerJobId: null, result: null },
                        projectId: "project",
                        projectStatus: "active",
                      },
                    ]
                  : [run]
                : [];
            return [
              {
                version: { id: "dsv" },
                projectId: "project",
                projectStatus: "active",
                archivedAt: null,
                importId: "import",
              },
            ];
          },
        };
        return query;
      },
    }),
    insert,
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const value = await callback({ insert });
      mocks.events.push("commit");
      return value;
    },
    update: () => ({ set: () => ({ where: async () => [] }) }),
  };
  return { db: db as unknown as DbClient, getRun: () => run, insert };
}
describe("durable execution authority", () => {
  it.each([
    "organizationId",
    "projectId",
    "canonicalChecksum",
    "sourceChecksum",
    "canonicalArtifactKey",
    "privateKey",
  ])("rejects browser %s authority", (field) => {
    expect(createExecutionSchema.safeParse({ ...request, [field]: "injected" }).success).toBe(
      false
    );
  });
  it("commits business start intent before Temporal, retaining it after start failure", async () => {
    const fixture = database();
    mocks.start.mockImplementation(async () => {
      mocks.events.push("temporal");
      throw new Error("provider unavailable");
    });
    const result = await new ExecutionService(fixture.db).create(
      context,
      request,
      "test-request-key-authority"
    );
    expect(result.workflowId).toBe(`analysis-run:${result.analysisRunId}`);
    expect(mocks.events).toEqual(["commit", "temporal"]);
    expect(fixture.getRun()).toMatchObject({
      organizationId: "trusted-org",
      status: "START_PENDING",
      executorSubject: "cellweave-orchestrator",
    });
  });
  it("reuses durable request identity and rejects a different request under the same key", async () => {
    const fixture = database();
    mocks.start.mockRejectedValue(new Error("start pending"));
    const service = new ExecutionService(fixture.db);
    const first = await service.create(context, request, "test-request-key-authority");
    const replay = await service.create(context, request, "test-request-key-authority");
    expect(replay).toEqual(first);
    expect(fixture.insert).toHaveBeenCalledTimes(3);
    await expect(
      service.create(
        context,
        { ...request, referenceBuild: "different" },
        "test-request-key-authority"
      )
    ).rejects.toThrow("Execution request identity conflict");
    expect(fixture.insert).toHaveBeenCalledTimes(3);
  });
  it("can start a cancellation intent whose original Temporal start was not acknowledged", async () => {
    const fixture = database();
    mocks.start.mockRejectedValue(new Error("not acknowledged"));
    const service = new ExecutionService(fixture.db);
    const created = await service.create(context, request, "early-cancel-request-key");
    const run = fixture.getRun();
    if (!run) throw new Error("Missing test run");
    run.status = "CANCEL_REQUESTED";
    mocks.start.mockResolvedValue({});
    await service.start(created.analysisRunId);
    expect(mocks.start).toHaveBeenLastCalledWith(
      "phase4ImportWorkflow",
      expect.objectContaining({
        workflowId: created.workflowId,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      })
    );
    expect(run.status).toBe("CANCEL_REQUESTED");
  });
  it("valid JWT cannot authorize an absent/unassigned resource", async () => {
    const keys = await generateKeyPair("ES256");
    const verifier = await createServiceTokenVerifier({
      environment: "development",
      keys: [{ kid: "current", publicKeyPem: await exportSPKI(keys.publicKey) }],
    });
    const token = await new SignJWT({ scope: ["execution.prepare"] })
      .setProtectedHeader({ alg: "ES256", kid: "current", typ: "JWT" })
      .setIssuer("cellweave-orchestrator:development")
      .setSubject("cellweave-orchestrator")
      .setAudience("cellweave-web-internal:development")
      .setIssuedAt()
      .setExpirationTime("5m")
      .setJti("correlation-unique-test")
      .sign(keys.privateKey);
    const executor = await verifier.verify(`Bearer ${token}`, ["execution.prepare"]);
    const query = { innerJoin: () => query, where: async () => [] };
    const db = { select: () => ({ from: () => query }) } as unknown as DbClient;
    await expect(
      new ExecutionService(db).resolve("foreign-run", executor, "execution.prepare")
    ).rejects.toThrow("Execution unavailable");
    // Even a real verified executor must re-authorize the persisted customer actor.
    const fixture = database();
    mocks.start.mockRejectedValue(new Error("pending"));
    const service = new ExecutionService(fixture.db);
    const created = await service.create(context, request, "token-tenant-authority-key");
    const record = await service.resolve(created.analysisRunId, executor, "execution.prepare");
    const revokedDb = {
      select: () => ({ from: () => ({ where: async () => [{ role: "viewer" }] }) }),
    } as unknown as DbClient;
    await expect(new ExecutionService(revokedDb).actor(record)).rejects.toThrow(
      "Execution unavailable"
    );
  });
});

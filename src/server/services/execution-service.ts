import "server-only";
import { createHash } from "node:crypto";
import { and, eq, sql, notInArray, inArray, asc } from "drizzle-orm";
import { z } from "zod";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import {
  ORGANISMS,
  GENE_ID_SCHEMES,
  RUN_TRANSITIONS,
  STEP_TRANSITIONS,
  type ExecutionEnvelope,
  SERVICE_ENVIRONMENTS,
  type ExecutionProjection,
  type ServiceScope,
  type TenantContext,
  type RunState,
  type WorkflowStepState,
} from "@cellweave/contracts";
import { generateDomainId } from "@/lib/id";
import { getDb, type DbClient } from "../database/client";
import {
  analysisRuns,
  workflowSteps,
  datasetVersions,
  datasets,
  datasetImports,
  datasetImportFiles,
  datasetFileProvenance,
  datasetFiles,
  member,
  auditEvents,
  projects,
  samples,
  experiments,
} from "../database/schema";
import { ProjectPermissionService } from "./project-permission-service";
import {
  ResourceNotFoundError,
  ValidationError,
  TenantAuthorizationError,
  ConflictError,
} from "../authorization/errors";
import { getTemporalClientService } from "../integrations/temporal/client";
import { R2StorageService } from "../integrations/storage/r2-storage-service";
import { issueCanonicalArtifactPublicationCapabilities } from "../integrations/storage/canonical-publication-capability";
import {
  validEnvelope,
  validCeilings,
  validMapping,
  validPrepared,
  validProjection,
} from "./execution-validation";

export const createExecutionSchema = z
  .object({
    datasetVersionId: z.string().min(1),
    pipelineVersion: z.string().min(1).max(100),
    organism: z.enum(ORGANISMS),
    geneIdScheme: z.enum(GENE_ID_SCHEMES),
    referenceBuild: z.string().min(1).nullable(),
    mapping: z.unknown().optional(),
  })
  .strict();
export type VerifiedExecutor = { subject: string; scopes: readonly ServiceScope[] };
const terminals: readonly RunState[] = ["SUCCEEDED", "FAILED", "CANCELLED"];
const scope = (executor: VerifiedExecutor, required: ServiceScope) => {
  if (executor.subject !== "cellweave-orchestrator" || !executor.scopes.includes(required))
    throw new TenantAuthorizationError("Execution unavailable");
};
function transition(from: RunState, to: RunState) {
  const allowed: readonly RunState[] = RUN_TRANSITIONS[from];
  if (from !== to && !allowed.includes(to)) throw new ConflictError("Invalid execution transition");
}

/** Business persistence owns identities, assignments and monotonic projections. */
export class ExecutionService {
  constructor(readonly db: DbClient = getDb()) {}
  async create(context: TenantContext, input: unknown, idempotencyKey: string) {
    if (context.role === "viewer") throw new TenantAuthorizationError();
    const request = createExecutionSchema.parse(structuredClone(input));
    const requestKey = z
      .string()
      .regex(/^[A-Za-z0-9._:-]{16,200}$/)
      .parse(idempotencyKey);
    function canonical(value: unknown): string {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      if (value && typeof value === "object")
        return `{${Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(",")}}`;
      return JSON.stringify(value);
    }
    const requestChecksum = createHash("sha256").update(canonical(request)).digest("hex");
    const [existing] = await this.db
      .select()
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.organizationId, context.organizationId),
          eq(analysisRuns.actorId, context.userId),
          eq(analysisRuns.requestKey, requestKey)
        )
      );
    if (existing) {
      await new ProjectPermissionService({ dbClient: this.db }).assertProjectAccess(
        context,
        existing.projectId
      );
      if (existing.requestChecksum !== requestChecksum)
        throw new ConflictError("Execution request identity conflict");
      if (existing.status === "START_PENDING") await this.start(existing.id).catch(() => undefined);
      return { analysisRunId: existing.id, workflowId: existing.temporalWorkflowId };
    }

    if (request.pipelineVersion !== process.env.EXECUTION_PIPELINE_VERSION)
      throw new ValidationError("Unsupported execution pipeline version");
    if (request.mapping !== undefined && !validMapping(request.mapping))
      throw new ValidationError("Invalid metadata mapping");
    const [parent] = await this.db
      .select({
        version: datasetVersions,
        projectId: datasets.projectId,
        versionSourceFormat: datasetVersions.sourceFormat,
        projectStatus: projects.status,
        archivedAt: projects.archivedAt,
        importId: datasetImports.id,
      })
      .from(datasetVersions)
      .innerJoin(
        datasets,
        and(
          eq(datasets.id, datasetVersions.datasetId),
          eq(datasets.organizationId, datasetVersions.organizationId)
        )
      )
      .innerJoin(
        projects,
        and(
          eq(projects.id, datasets.projectId),
          eq(projects.organizationId, datasets.organizationId)
        )
      )
      .innerJoin(
        datasetImports,
        and(
          eq(datasetImports.datasetVersionId, datasetVersions.id),
          eq(datasetImports.organizationId, datasetVersions.organizationId)
        )
      )
      .where(
        and(
          eq(datasetVersions.id, request.datasetVersionId),
          eq(datasetVersions.organizationId, context.organizationId)
        )
      );
    if (!parent) throw new ResourceNotFoundError("Dataset version unavailable");
    await new ProjectPermissionService({ dbClient: this.db }).assertProjectAccess(
      context,
      parent.projectId
    );
    if (request.mapping !== undefined && validMapping(request.mapping)) {
      const mapping = request.mapping;
      if (
        mapping.datasetVersionId !== request.datasetVersionId ||
        mapping.organism !== request.organism ||
        mapping.geneIdScheme !== request.geneIdScheme ||
        (mapping.referenceBuild !== undefined &&
          (mapping.referenceBuild ?? null) !== request.referenceBuild)
      )
        throw new ValidationError("Inconsistent metadata mapping");
      const keys = [...new Set((mapping.sampleMappings ?? []).map((value) => value.sampleKey))];
      if (keys.length) {
        const registered = await this.db
          .select({ sampleKey: samples.sampleKey })
          .from(samples)
          .innerJoin(
            experiments,
            and(
              eq(experiments.id, samples.experimentId),
              eq(experiments.organizationId, samples.organizationId)
            )
          )
          .where(
            and(
              eq(samples.organizationId, context.organizationId),
              eq(experiments.projectId, parent.projectId),
              inArray(samples.sampleKey, keys)
            )
          );
        if (keys.some((key) => registered.filter((row) => row.sampleKey === key).length !== 1))
          throw new ValidationError("Sample mapping unavailable in active project");
      }
    }
    if (parent.projectStatus !== "active" || parent.archivedAt)
      throw new ValidationError("Project unavailable for execution");
    let ceilings: unknown;
    try {
      ceilings = JSON.parse(process.env.EXECUTION_CEILINGS_JSON ?? "null");
    } catch {
      throw new ValidationError("Execution ceilings unavailable");
    }
    if (
      !validCeilings(ceilings) ||
      ceilings.estimatedComputeUnits > ceilings.maxComputeUnits ||
      ceilings.maxRuntimeSeconds > 3300 ||
      ceilings.resourceClass !== ceilings.maxMemoryClass ||
      !ceilings.resourceClass.startsWith("CPU_")
    )
      throw new ValidationError("Invalid configured execution ceilings");
    const runId = generateDomainId("run");
    const stepId = generateDomainId("wfs");
    const environment = z.enum(SERVICE_ENVIRONMENTS).parse(process.env.SERVICE_AUTH_ENVIRONMENT);
    const envelope: ExecutionEnvelope = {
      environment,
      schemaVersion: "1.0.0",
      deadlineAt: new Date(Date.now() + (ceilings.maxRuntimeSeconds + 300) * 1000).toISOString(),
      analysisRunId: runId,
      organizationId: context.organizationId,
      projectId: parent.projectId,
      datasetVersionId: request.datasetVersionId,
      importId: parent.importId,
      pipelineVersion: request.pipelineVersion,
      stepId,
      submissionId: `${runId}:canonicalize`,
      ceilings,
      organism: request.organism,
      geneIdScheme: request.geneIdScheme,
      referenceBuild: request.referenceBuild,
      ...(request.mapping === undefined ? {} : { mapping: request.mapping }),
    };
    if (!validEnvelope(envelope)) throw new ValidationError("Invalid execution request");
    const workflowId = `analysis-run:${runId}`;
    const persisted = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(analysisRuns)
        .values({
          id: runId,
          organizationId: context.organizationId,
          projectId: parent.projectId,
          datasetVersionId: request.datasetVersionId,
          pipelineVersion: request.pipelineVersion,
          actorId: context.userId,
          requestKey,
          requestChecksum,
          executorSubject: "cellweave-orchestrator",
          temporalWorkflowId: workflowId,
          status: "START_PENDING",
          envelope,
        })
        .onConflictDoNothing({
          target: [analysisRuns.organizationId, analysisRuns.actorId, analysisRuns.requestKey],
        })
        .returning({ id: analysisRuns.id, workflowId: analysisRuns.temporalWorkflowId });
      if (!inserted.length) {
        const [winner] = await tx
          .select()
          .from(analysisRuns)
          .where(
            and(
              eq(analysisRuns.organizationId, context.organizationId),
              eq(analysisRuns.actorId, context.userId),
              eq(analysisRuns.requestKey, requestKey)
            )
          );
        if (!winner || winner.requestChecksum !== requestChecksum)
          throw new ConflictError("Execution request identity conflict");
        return { analysisRunId: winner.id, workflowId: winner.temporalWorkflowId };
      }
      await tx.insert(workflowSteps).values({
        id: stepId,
        organizationId: context.organizationId,
        analysisRunId: runId,
        stepKey: "canonicalize",
        stepVersion: request.pipelineVersion,
        submissionId: envelope.submissionId,
      });
      await tx.insert(auditEvents).values({
        id: generateDomainId("aud"),
        organizationId: context.organizationId,
        actorType: "user",
        actorId: context.userId,
        action: "analysis_run.created",
        resourceType: "analysis_run",
        resourceId: runId,
        metadata: { workflowId },
      });
      return { analysisRunId: runId, workflowId };
    });
    // Deliberately after commit. Failure leaves a durable, reconcilable start intent.
    await this.start(persisted.analysisRunId).catch(() => undefined);
    return persisted;
  }
  async resolve(runId: string, executor: VerifiedExecutor, required: ServiceScope) {
    scope(executor, required);
    const [record] = await this.db
      .select({
        run: analysisRuns,
        step: workflowSteps,
        projectId: datasets.projectId,
        versionSourceFormat: datasetVersions.sourceFormat,
        projectStatus: projects.status,
      })
      .from(analysisRuns)
      .innerJoin(
        workflowSteps,
        and(
          eq(workflowSteps.analysisRunId, analysisRuns.id),
          eq(workflowSteps.organizationId, analysisRuns.organizationId)
        )
      )
      .innerJoin(
        datasetVersions,
        and(
          eq(datasetVersions.id, analysisRuns.datasetVersionId),
          eq(datasetVersions.organizationId, analysisRuns.organizationId)
        )
      )
      .innerJoin(
        datasets,
        and(
          eq(datasets.id, datasetVersions.datasetId),
          eq(datasets.organizationId, analysisRuns.organizationId)
        )
      )
      .innerJoin(
        projects,
        and(
          eq(projects.id, datasets.projectId),
          eq(projects.organizationId, analysisRuns.organizationId)
        )
      )
      .where(
        and(
          eq(analysisRuns.id, runId),
          eq(analysisRuns.executorSubject, executor.subject),
          eq(analysisRuns.kind, "IMPORT")
        )
      );
    if (!record || record.projectId !== record.run.projectId)
      throw new ResourceNotFoundError("Execution unavailable");
    return record;
  }
  async actor(record: Awaited<ReturnType<ExecutionService["resolve"]>>): Promise<TenantContext> {
    const rows = await this.db
      .select({ role: member.role })
      .from(member)
      .where(
        and(
          eq(member.organizationId, record.run.organizationId),
          eq(member.userId, record.run.actorId)
        )
      );
    const role = rows.length === 1 ? rows[0]?.role : undefined;
    if (role !== "owner" && role !== "admin" && role !== "bioinformatician" && role !== "scientist")
      throw new TenantAuthorizationError("Execution unavailable");
    const context: TenantContext = {
      organizationId: record.run.organizationId,
      userId: record.run.actorId,
      role,
    };
    await new ProjectPermissionService({ dbClient: this.db }).assertProjectAccess(
      context,
      record.run.projectId
    );
    return context;
  }
  async start(runId: string) {
    const executor: VerifiedExecutor = {
      subject: "cellweave-orchestrator",
      scopes: ["execution.prepare"],
    };
    const record = await this.resolve(runId, executor, "execution.prepare");
    if (record.run.status !== "START_PENDING" && record.run.status !== "CANCEL_REQUESTED") return;
    const taskQueue = process.env.TEMPORAL_TASK_QUEUE;
    if (!taskQueue) throw new ValidationError("Temporal task queue unavailable");
    const client = await getTemporalClientService().getClient();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(record.run.envelope))
      .digest("hex");
    try {
      await client.workflow.start("phase4ImportWorkflow", {
        workflowId: record.run.temporalWorkflowId,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        taskQueue,
        args: [runId],
        memo: { analysisRunId: runId, executionFingerprint: fingerprint },
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError))
        throw new ConflictError("Workflow start pending reconciliation");
      const existing = await client.workflow.getHandle(record.run.temporalWorkflowId).describe();
      if (
        existing.type !== "phase4ImportWorkflow" ||
        existing.memo?.analysisRunId !== runId ||
        existing.memo?.executionFingerprint !== fingerprint
      )
        throw new ConflictError("Workflow identity conflict");
    }
    await this.db
      .update(analysisRuns)
      .set({ status: "QUEUED", updatedAt: new Date() })
      .where(and(eq(analysisRuns.id, runId), eq(analysisRuns.status, "START_PENDING")));
  }
  async reconcileStarts(executor: VerifiedExecutor) {
    scope(executor, "execution.prepare");
    scope(executor, "execution.project");
    const pending = await this.db
      .select()
      .from(analysisRuns)
      .where(
        and(
          notInArray(analysisRuns.status, ["SUCCEEDED", "FAILED", "CANCELLED"]),
          eq(analysisRuns.executorSubject, executor.subject),
          eq(analysisRuns.kind, "IMPORT")
        )
      )
      .orderBy(asc(analysisRuns.updatedAt))
      .limit(100);
    let reconciled = 0;
    for (const run of pending) {
      try {
        if (run.status === "START_PENDING" || run.status === "CANCEL_REQUESTED")
          await this.start(run.id);
        else {
          const client = await getTemporalClientService().getClient();
          const handle = client.workflow.getHandle(run.temporalWorkflowId);
          const description = await handle.describe();
          if (description.type !== "phase4ImportWorkflow") continue;
          if (description.status.name === "RUNNING") {
            const waiting: unknown = await handle.query("needsReconciliation");
            if (waiting === true) await handle.signal("reconcile");
            if (run.cancelRequested) {
              const control = await this.control(run.id, executor);
              if (!control.finalizationStarted) await handle.cancel();
            }
          } else if (description.status.name === "FAILED") {
            await this.project(
              {
                analysisRunId: run.id,
                sequence: run.projectionVersion + 1,
                status: "FAILED",
                stepState: "FAILED",
                failureCode: "WORKFLOW_FAILED",
              },
              executor
            );
          } else if (description.status.name === "COMPLETED") {
            const result: unknown = await handle.result();
            const output = z
              .object({
                analysisRunId: z.literal(run.id),
                status: z.enum(["SUCCEEDED", "CANCELLED"]),
              })
              .strict()
              .safeParse(result);
            if (output.success)
              await this.project(
                {
                  analysisRunId: run.id,
                  sequence: run.projectionVersion + 1,
                  status: output.data.status,
                  stepState: output.data.status,
                },
                executor
              );
          }
        }
        reconciled++;
      } catch {
        /* durable intent/state remains for next bounded reconciliation batch */
      } finally {
        // Rotate bounded batches fairly, including executions awaiting provider reconciliation.
        await this.db
          .update(analysisRuns)
          .set({ updatedAt: new Date() })
          .where(eq(analysisRuns.id, run.id))
          .catch(() => undefined);
      }
    }
    return { examined: pending.length, reconciled };
  }
  async control(runId: string, executor: VerifiedExecutor) {
    const { run, step } = await this.resolve(runId, executor, "execution.prepare");
    return {
      analysisRunId: run.id,
      status: run.status,
      cancelRequested: run.cancelRequested,
      projectionVersion: run.projectionVersion,
      providerJobId: step.providerJobId,
      providerState: step.providerState,
      finalizationStarted: step.finalizationStarted,
      result: step.result,
      submissionId: step.submissionId,
    };
  }
  async prepare(runId: string, executor: VerifiedExecutor) {
    scope(executor, "capability.issue");
    const record = await this.resolve(runId, executor, "execution.prepare");
    await this.actor(record);
    if (record.projectStatus !== "active")
      throw new TenantAuthorizationError("Execution unavailable");
    const files = await this.db
      .select({
        datasetFileId: datasetFiles.id,
        fileName: datasetFiles.fileName,
        byteSize: datasetFiles.byteSize,
        sha256: datasetFileProvenance.sha256,
        role: datasetImportFiles.role,
        ordinal: datasetImportFiles.ordinal,
        r2Key: datasetFiles.r2Key,
      })
      .from(datasetImportFiles)
      .innerJoin(
        datasetFiles,
        and(
          eq(datasetFiles.id, datasetImportFiles.datasetFileId),
          eq(datasetFiles.organizationId, datasetImportFiles.organizationId),
          eq(datasetFiles.datasetVersionId, datasetImportFiles.datasetVersionId)
        )
      )
      .innerJoin(
        datasetFileProvenance,
        and(
          eq(datasetFileProvenance.datasetFileId, datasetFiles.id),
          eq(datasetFileProvenance.organizationId, datasetFiles.organizationId),
          eq(datasetFileProvenance.datasetVersionId, datasetFiles.datasetVersionId),
          eq(datasetFileProvenance.r2Key, datasetFiles.r2Key)
        )
      )
      .where(
        and(
          eq(datasetImportFiles.importId, record.run.envelope.importId),
          eq(datasetImportFiles.organizationId, record.run.organizationId),
          eq(datasetImportFiles.datasetVersionId, record.run.datasetVersionId)
        )
      );
    const [manifest] = await this.db
      .select()
      .from(datasetImports)
      .where(
        and(
          eq(datasetImports.id, record.run.envelope.importId),
          eq(datasetImports.organizationId, record.run.organizationId),
          eq(datasetImports.datasetVersionId, record.run.datasetVersionId)
        )
      );
    if (!manifest || !files.length) throw new ResourceNotFoundError("Execution input unavailable");
    const storage = new R2StorageService();
    const expiry = record.run.envelope.ceilings.maxRuntimeSeconds + 300;
    const targets = await Promise.all(
      files.map(async ({ r2Key, ...file }) => ({
        ...file,
        downloadUrl: await storage.createPresignedDownloadUrl({
          objectKey: r2Key,
          expiresInSeconds: expiry,
        }),
      }))
    );
    const publication = await issueCanonicalArtifactPublicationCapabilities({
      organizationId: record.run.organizationId,
      projectId: record.run.projectId,
      datasetVersionId: record.run.datasetVersionId,
      expiresInSeconds: expiry,
    });
    const prepared = {
      envelope: record.run.envelope,
      sourceFormat: manifest.sourceFormat,
      sourceChecksum: manifest.sourceChecksum,
      files: targets,
      publication,
    };
    if (!validPrepared(prepared)) throw new ValidationError("Execution input unavailable");
    return prepared;
  }
  async project(input: unknown, executor: VerifiedExecutor) {
    if (!validProjection(input)) throw new ValidationError("Invalid projection");
    const event: ExecutionProjection = input;
    const record = await this.resolve(event.analysisRunId, executor, "execution.project");
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, record.run.id))
        .for("update");
      if (!current) throw new ResourceNotFoundError("Execution unavailable");
      if (event.sequence <= current.projectionVersion)
        return { applied: false, projectionVersion: current.projectionVersion };
      transition(current.status, event.status);
      const [currentStep] = await tx
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.id, record.step.id))
        .for("update");
      if (!currentStep) throw new ResourceNotFoundError("Execution unavailable");
      const stepTransitions: readonly WorkflowStepState[] = STEP_TRANSITIONS[currentStep.status];
      if (currentStep.status !== event.stepState && !stepTransitions.includes(event.stepState))
        throw new ConflictError("Invalid workflow step transition");

      // Scientific success can only be projected after the trusted finalization operation.
      if (event.status === "SUCCEEDED" && !currentStep.result)
        throw new ConflictError("Finalization required");
      await tx
        .update(analysisRuns)
        .set({ status: event.status, projectionVersion: event.sequence, updatedAt: new Date() })
        .where(eq(analysisRuns.id, current.id));
      await tx
        .update(workflowSteps)
        .set({
          status: event.stepState,
          attempt:
            event.stepState === "RUNNING" && currentStep.attempt === 0 ? 1 : currentStep.attempt,
          provenance: {
            ...currentStep.provenance,
            ...(event.failureCode ? { failureCode: event.failureCode } : {}),
            ...(event.stepState === "RUNNING" && !currentStep.provenance.startedProjectionAt
              ? { startedProjectionAt: new Date().toISOString() }
              : {}),
            ...(["SUCCEEDED", "FAILED", "CANCELLED"].includes(event.stepState) &&
            !currentStep.provenance.terminalProjectionAt
              ? { terminalProjectionAt: new Date().toISOString() }
              : {}),
          },
          updatedAt: new Date(),
        })
        .where(eq(workflowSteps.id, record.step.id));
      return { applied: true, projectionVersion: event.sequence };
    });
  }
  async mapProvider(
    runId: string,
    providerJobId: string | undefined,
    providerState: string,
    executor: VerifiedExecutor
  ) {
    const record = await this.resolve(runId, executor, "execution.project");
    const state = z
      .enum(["UNKNOWN", "PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"])
      .parse(providerState);
    if ((!providerJobId && state !== "CANCELLED") || (providerJobId && providerJobId.length > 500))
      throw new ValidationError("Invalid provider identity");
    const rows = await this.db
      .update(workflowSteps)
      .set({
        ...(providerJobId ? { providerJobId } : {}),
        providerState: state,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workflowSteps.id, record.step.id),
          providerJobId
            ? sql`(${workflowSteps.providerJobId} IS NULL OR ${workflowSteps.providerJobId}=${providerJobId})`
            : sql`${workflowSteps.providerJobId} IS NULL`,
          sql`(${workflowSteps.providerState} NOT IN ('COMPLETED','FAILED','CANCELLED','TIMEOUT') OR ${workflowSteps.providerState}=${state})`
        )
      )
      .returning({ id: workflowSteps.id });
    if (rows.length !== 1) {
      const [current] = await this.db
        .select()
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.id, record.step.id),
            eq(workflowSteps.organizationId, record.run.organizationId)
          )
        );
      if (
        current &&
        current.providerJobId === (providerJobId ?? null) &&
        ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"].includes(current.providerState)
      )
        return { recorded: false };
      throw new ConflictError("Provider identity conflict");
    }
    return { recorded: true };
  }
  async cancel(context: TenantContext, runId: string) {
    const [record] = await this.db
      .select()
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.id, runId),
          eq(analysisRuns.organizationId, context.organizationId),
          eq(analysisRuns.kind, "IMPORT")
        )
      );
    if (!record) throw new ResourceNotFoundError("Execution unavailable");
    if (context.role === "viewer") throw new TenantAuthorizationError();
    await new ProjectPermissionService({ dbClient: this.db }).assertProjectAccess(
      context,
      record.projectId
    );
    const outcome = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, runId))
        .for("update");
      const [step] = await tx
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.analysisRunId, runId));
      if (!current || !step) throw new ResourceNotFoundError("Execution unavailable");
      if (terminals.includes(current.status)) return { terminal: true, tooLate: true };
      await tx
        .update(analysisRuns)
        .set({
          cancelRequested: true,
          ...(step.finalizationStarted ? {} : { status: "CANCEL_REQUESTED" as const }),
          updatedAt: new Date(),
        })
        .where(eq(analysisRuns.id, runId));
      return { terminal: false, tooLate: step.finalizationStarted };
    });
    if (!outcome.terminal && !outcome.tooLate) {
      try {
        await (
          await getTemporalClientService().getClient()
        ).workflow
          .getHandle(record.temporalWorkflowId)
          .cancel();
      } catch {
        /* persisted intent is reconciled by workflow */
      }
    }
    return outcome;
  }
}

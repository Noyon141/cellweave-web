import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, asc, notInArray, isNotNull, desc } from "drizzle-orm";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type {
  TenantContext,
  ServiceScope,
  QcStartRequest,
  QcSelectionParameters,
  QcApprovalRequest,
  QcAnalysisParameters,
  QcStepContext,
  QcDecision,
  QcPreparedExecution,
  QcJobResult,
  QcControl,
  QcArtifactTarget,
  ExecutionEnvelope,
  RunState,
} from "@cellweave/contracts";
import {
  RUN_TRANSITIONS,
  SERVICE_ENVIRONMENTS,
  ORGANISMS,
  GENE_ID_SCHEMES,
} from "@cellweave/contracts";
import { z } from "zod";
import { generateDomainId } from "@/lib/id";
import { getDb, type DbClient } from "../database/client";
import {
  analysisRuns,
  workflowSteps,
  qcRevisions,
  qcDecisions,
  artifacts,
  artifactLineage,
  datasetVersions,
  datasets,
  datasetImports,
  projects,
  member,
  samples,
  experiments,
  auditEvents,
  projectMembers,
} from "../database/schema";
import { ProjectPermissionService } from "./project-permission-service";
import {
  ConflictError,
  ValidationError,
  ResourceNotFoundError,
  TenantAuthorizationError,
} from "../authorization/errors";
import { getTemporalClientService } from "../integrations/temporal/client";
import { assertRole } from "../authorization/guards";
import {
  R2QcArtifactStorage,
  buildQcArtifactKey,
  type QcArtifactStorage,
} from "../integrations/storage/qc-artifact-storage";
import { buildCanonicalDatasetKey } from "../integrations/storage/object-key";
import {
  validQcStartRequest,
  validQcSelectionParameters,
  validQcApprovalRequest,
  validQcPreparedExecution,
  validQcJobResult,
  validQcDecision,
  validQcControl,
  validQcProjection,
  validCeilings,
  validEnvelope,
} from "./execution-validation";
import { qcSelectionChecksum } from "./qc-checksum";
import type { VerifiedExecutor } from "./execution-service";
const terminal = (state: RunState) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(state);
const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const requestKey = (value: string) =>
  z
    .string()
    .regex(/^[A-Za-z0-9._:-]{16,200}$/)
    .parse(value);
function scope(executor: VerifiedExecutor, required: ServiceScope) {
  if (executor.subject !== "cellweave-orchestrator" || !executor.scopes.includes(required))
    throw new TenantAuthorizationError("QC execution unavailable");
}
function ceiling(operation: QcStepContext["operation"]) {
  let value: unknown;
  try {
    value = JSON.parse(
      process.env[
        operation === "FILTER" ? "QC_FILTER_CEILINGS_JSON" : "QC_ANALYSIS_CEILINGS_JSON"
      ] ?? "null"
    );
  } catch {
    throw new ValidationError("QC ceilings unavailable");
  }
  if (
    !validCeilings(value) ||
    value.maxRuntimeSeconds > 3300 ||
    value.estimatedComputeUnits > value.maxComputeUnits ||
    value.resourceClass !== value.maxMemoryClass ||
    !value.resourceClass.startsWith("CPU_")
  )
    throw new ValidationError("Invalid QC ceilings");
  return value;
}
const files = (operation: QcStepContext["operation"]): readonly QcArtifactTarget["fileName"][] =>
  operation === "QC"
    ? ["qc_metrics.jsonl.gz", "qc_summary.json"]
    : operation === "PREVIEW"
      ? ["selection.jsonl.gz"]
      : ["filtered.h5ad"];
function stepContext(
  operation: QcStepContext["operation"],
  revision: number,
  selection: QcSelectionParameters | null = null,
  decisionId: string | null = null
): QcStepContext {
  return {
    operation,
    revision,
    selection,
    decisionId,
    deadlineAt: null,
    outputIds: files(operation).map(() => generateDomainId("art")),
  };
}

/** Business orchestration only. Scientific masks/counts originate exclusively in science. */
export class QcService {
  constructor(
    readonly db: DbClient = getDb(),
    readonly storage: QcArtifactStorage = new R2QcArtifactStorage()
  ) {}
  async resolve(runId: string) {
    const [record] = await this.db
      .select({
        run: analysisRuns,
        revision: qcRevisions,
        version: datasetVersions,
        projectId: datasets.projectId,
        projectStatus: projects.status,
      })
      .from(analysisRuns)
      .innerJoin(
        qcRevisions,
        and(
          eq(qcRevisions.analysisRunId, analysisRuns.id),
          eq(qcRevisions.organizationId, analysisRuns.organizationId),
          eq(qcRevisions.projectId, analysisRuns.projectId)
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
          eq(analysisRuns.kind, "QC"),
          eq(analysisRuns.executorSubject, "cellweave-orchestrator")
        )
      );
    if (!record || record.run.projectId !== record.projectId)
      throw new ResourceNotFoundError("QC execution unavailable");
    return record;
  }
  async authorize(context: TenantContext, runId: string, write = false) {
    const record = await this.resolve(runId);
    if (record.run.organizationId !== context.organizationId)
      throw new ResourceNotFoundError("QC execution unavailable");
    if (write) assertRole(context, ["owner", "admin", "bioinformatician", "scientist"]);
    await new ProjectPermissionService({ dbClient: this.db }).assertProjectAccess(
      context,
      record.projectId
    );
    return record;
  }
  async actor(
    record: Awaited<ReturnType<QcService["resolve"]>>,
    actorId = record.run.actorId
  ): Promise<TenantContext> {
    const rows = await this.db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, record.run.organizationId), eq(member.userId, actorId)));
    const role = rows.length === 1 ? rows[0]?.role : null;
    if (role !== "owner" && role !== "admin" && role !== "scientist" && role !== "bioinformatician")
      throw new TenantAuthorizationError("QC execution unavailable");
    const context: TenantContext = {
      organizationId: record.run.organizationId,
      userId: actorId,
      role,
    };
    await new ProjectPermissionService({ dbClient: this.db }).assertProjectAccess(
      context,
      record.projectId
    );
    return context;
  }
  async create(context: TenantContext, input: unknown, key: string) {
    assertRole(context, ["owner", "admin", "bioinformatician", "scientist"]);
    if (!validQcStartRequest(input)) throw new ValidationError("Invalid QC request");
    const request: QcStartRequest = structuredClone(input);
    if (
      request.captureBindings.some(
        (binding) =>
          binding.captureGroupKey !== binding.captureGroupKey.trim() ||
          !binding.captureGroupKey.trim()
      )
    )
      throw new ValidationError("Invalid capture identity");
    const idempotency = requestKey(key),
      digest = hash(request);
    const [existing] = await this.db
      .select()
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.organizationId, context.organizationId),
          eq(analysisRuns.actorId, context.userId),
          eq(analysisRuns.requestKey, idempotency)
        )
      );
    if (existing) {
      await this.authorize(context, existing.id, true);
      if (existing.requestChecksum !== digest) throw new ConflictError("QC request conflict");
      await this.start(existing.id).catch(() => undefined);
      return { analysisRunId: existing.id, workflowId: existing.temporalWorkflowId };
    }
    const [parent] = await this.db
      .select({
        version: datasetVersions,
        projectId: datasets.projectId,
        importId: datasetImports.id,
        projectStatus: projects.status,
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
    if (!parent) throw new ResourceNotFoundError("Dataset unavailable");
    await new ProjectPermissionService({ dbClient: this.db }).assertProjectAccess(
      context,
      parent.projectId
    );
    if (
      !parent.version.canonicalChecksum ||
      parent.version.canonicalFormat !== "H5AD" ||
      parent.projectStatus !== "active"
    )
      throw new ValidationError("Finalized canonical input required");
    const registered = await this.db
      .select({ sampleId: samples.id, sampleKey: samples.sampleKey })
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
          eq(experiments.projectId, parent.projectId)
        )
      );
    if (
      registered.length > 1000 ||
      new Set(registered.map((row) => row.sampleKey)).size !== registered.length
    )
      throw new ValidationError("Sample metadata ambiguous or exceeds bounded QC metadata");
    if (
      new Set(request.captureBindings.map((row) => row.sampleId)).size !==
        request.captureBindings.length ||
      request.captureBindings.some(
        (binding) => !registered.some((row) => row.sampleId === binding.sampleId)
      ) ||
      (request.wholeInputSampleId !== null &&
        !registered.some((row) => row.sampleId === request.wholeInputSampleId))
    )
      throw new ValidationError("Capture/sample binding unavailable");
    const analysis: QcAnalysisParameters = {
      geneSetPolicy: "cellweave-symbol-prefixes-v1",
      scrubletProfile: "cellweave-scanpy-scrublet-v1",
      randomSeed: 42,
      wholeInputSampleId: request.wholeInputSampleId,
      samples: registered.map((row) => ({
        ...row,
        captureGroupKey:
          request.captureBindings.find((binding) => binding.sampleId === row.sampleId)
            ?.captureGroupKey ?? null,
        expectedDoubletRate: null,
      })),
    };
    const pipelineVersion = z.string().min(1).parse(process.env.QC_PIPELINE_VERSION);
    const limits = ceiling("QC");
    ceiling("FILTER");
    const runId = generateDomainId("run"),
      stepId = generateDomainId("wfs"),
      artifactId = generateDomainId("art");
    const workflowId = `analysis-run:${runId}`;
    const envelope: ExecutionEnvelope = {
      schemaVersion: "1.0.0",
      environment: z.enum(SERVICE_ENVIRONMENTS).parse(process.env.SERVICE_AUTH_ENVIRONMENT),
      analysisRunId: runId,
      projectId: parent.projectId,
      organizationId: context.organizationId,
      datasetVersionId: request.datasetVersionId,
      importId: parent.importId,
      stepId,
      submissionId: `${runId}:qc:1`,
      pipelineVersion,
      deadlineAt: new Date(Date.now() + (limits.maxRuntimeSeconds + 300) * 1000).toISOString(),
      ceilings: limits,
      organism: z.enum(ORGANISMS).parse(parent.version.organism),
      geneIdScheme: z.enum(GENE_ID_SCHEMES).parse(parent.version.geneIdScheme),
      referenceBuild: parent.version.referenceBuild,
    };
    if (!validEnvelope(envelope)) throw new ValidationError("Invalid QC setup");
    const [canonical] = await this.db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.datasetVersionId, request.datasetVersionId),
          eq(artifacts.organizationId, context.organizationId),
          eq(artifacts.artifactType, "CANONICAL_DATASET")
        )
      );
    const objectKey = buildCanonicalDatasetKey({
      organizationId: context.organizationId,
      projectId: parent.projectId,
      datasetVersionId: request.datasetVersionId,
    });
    const size = canonical?.sizeBytes ?? (await this.storage.size(objectKey));
    const created = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(analysisRuns)
        .values({
          id: runId,
          organizationId: context.organizationId,
          projectId: parent.projectId,
          datasetVersionId: request.datasetVersionId,
          kind: "QC",
          actorId: context.userId,
          requestKey: idempotency,
          requestChecksum: digest,
          executorSubject: "cellweave-orchestrator",
          pipelineVersion,
          temporalWorkflowId: workflowId,
          envelope,
          status: "START_PENDING",
        })
        .onConflictDoNothing({
          target: [analysisRuns.organizationId, analysisRuns.actorId, analysisRuns.requestKey],
        })
        .returning();
      if (!inserted.length) {
        const [winner] = await tx
          .select()
          .from(analysisRuns)
          .where(
            and(
              eq(analysisRuns.organizationId, context.organizationId),
              eq(analysisRuns.actorId, context.userId),
              eq(analysisRuns.requestKey, idempotency)
            )
          );
        if (!winner || winner.kind !== "QC" || winner.requestChecksum !== digest)
          throw new ConflictError("QC request conflict");
        return { analysisRunId: winner.id, workflowId: winner.temporalWorkflowId };
      }
      await tx.insert(workflowSteps).values({
        id: stepId,
        organizationId: context.organizationId,
        analysisRunId: runId,
        stepKey: "qc:1",
        stepVersion: pipelineVersion,
        submissionId: envelope.submissionId,
        qcContext: stepContext("QC", 1),
      });
      if (!canonical)
        await tx
          .insert(artifacts)
          .values({
            id: artifactId,
            organizationId: context.organizationId,
            projectId: parent.projectId,
            datasetVersionId: request.datasetVersionId,
            artifactType: "CANONICAL_DATASET",
            bucket: this.storage.bucket(),
            objectKey,
            sha256: parent.version.canonicalChecksum!,
            sizeBytes: size,
            mimeType: "application/x-hdf5",
            metadata: { authority: "dataset_versions" },
          })
          .onConflictDoNothing();
      const [bound] = await tx
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.datasetVersionId, request.datasetVersionId),
            eq(artifacts.organizationId, context.organizationId),
            eq(artifacts.artifactType, "CANONICAL_DATASET")
          )
        );
      if (
        !bound ||
        bound.sha256 !== parent.version.canonicalChecksum ||
        bound.projectId !== parent.projectId
      )
        throw new ConflictError("Canonical artifact conflict");
      await tx.insert(qcRevisions).values({
        analysisRunId: runId,
        organizationId: context.organizationId,
        projectId: parent.projectId,
        canonicalArtifactId: bound.id,
        qcStepId: stepId,
        analysisParameters: analysis,
      });
      await tx.insert(auditEvents).values({
        id: generateDomainId("aud"),
        organizationId: context.organizationId,
        actorType: "user",
        actorId: context.userId,
        action: "qc.created",
        resourceType: "analysis_run",
        resourceId: runId,
        metadata: { workflowId },
      });
      return { analysisRunId: runId, workflowId };
    });
    await this.start(created.analysisRunId).catch(() => undefined);
    return created;
  }
  async start(runId: string) {
    const record = await this.resolve(runId);
    if (record.run.status !== "START_PENDING" && record.run.status !== "CANCEL_REQUESTED") return;
    const taskQueue = z.string().min(1).parse(process.env.TEMPORAL_TASK_QUEUE);
    const client = await getTemporalClientService().getClient();
    try {
      await client.workflow.start("phase5QcWorkflow", {
        workflowId: record.run.temporalWorkflowId,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        taskQueue,
        args: [runId],
        memo: { analysisRunId: runId, kind: "QC" },
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError))
        throw new ConflictError("QC start pending");
      const found = await client.workflow.getHandle(record.run.temporalWorkflowId).describe();
      if (
        found.type !== "phase5QcWorkflow" ||
        found.memo?.analysisRunId !== runId ||
        found.memo?.kind !== "QC"
      )
        throw new ConflictError("QC workflow identity conflict");
    }
    await this.db
      .update(analysisRuns)
      .set({ status: "QUEUED", updatedAt: new Date() })
      .where(and(eq(analysisRuns.id, runId), eq(analysisRuns.status, "START_PENDING")));
  }
  async step(record: Awaited<ReturnType<QcService["resolve"]>>, stepId: string) {
    const [step] = await this.db
      .select()
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.id, stepId),
          eq(workflowSteps.organizationId, record.run.organizationId),
          eq(workflowSteps.analysisRunId, record.run.id)
        )
      );
    if (!step?.qcContext) throw new ResourceNotFoundError("QC step unavailable");
    return { ...step, qcContext: step.qcContext };
  }
  async control(runId: string, executor: VerifiedExecutor): Promise<QcControl> {
    scope(executor, "execution.prepare");
    const record = await this.resolve(runId);
    const steps = await this.db
      .select()
      .from(workflowSteps)
      .where(
        and(
          eq(workflowSteps.analysisRunId, runId),
          eq(workflowSteps.organizationId, record.run.organizationId)
        )
      )
      .orderBy(asc(workflowSteps.stepKey));
    const [decision] = record.revision.decisionId
      ? await this.db
          .select()
          .from(qcDecisions)
          .where(
            and(
              eq(qcDecisions.id, record.revision.decisionId),
              eq(qcDecisions.organizationId, record.run.organizationId),
              eq(qcDecisions.analysisRunId, runId)
            )
          )
      : [];
    const result = {
      analysisRunId: runId,
      status: record.run.status,
      projectionVersion: record.run.projectionVersion,
      cancelRequested: record.run.cancelRequested,
      filterCommitted: record.revision.filterCommitted,
      qcRevision: record.revision.qcRevision,
      steps: steps
        .filter((step) => step.qcContext !== null)
        .map((step) => ({
          stepId: step.id,
          submissionId: step.submissionId,
          status: step.status,
          providerJobId: step.providerJobId,
          providerState: step.providerState,
          context: step.qcContext,
          result: step.qcResult,
        })),
      decision: decision?.decision ?? null,
      approvalPending: record.revision.approvalPending,
    };
    if (!validQcControl(result)) throw new ValidationError("Invalid QC state");
    return result;
  }
  async prepare(
    runId: string,
    stepId: string,
    executor: VerifiedExecutor
  ): Promise<QcPreparedExecution> {
    scope(executor, "execution.prepare");
    scope(executor, "capability.issue");
    const record = await this.resolve(runId);
    const requestedStep = await this.step(record, stepId);
    if (requestedStep.qcContext.operation === "FILTER")
      await this.decision(runId, requestedStep.qcContext.decisionId ?? "", executor);
    else await this.actor(record);
    if (record.projectStatus !== "active") throw new TenantAuthorizationError();
    const step = await this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, runId))
        .for("update");
      const [step] = await tx
        .select()
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.id, stepId),
            eq(workflowSteps.analysisRunId, runId),
            eq(workflowSteps.organizationId, record.run.organizationId)
          )
        )
        .for("update");
      if (!run || run.cancelRequested || terminal(run.status) || !step?.qcContext)
        throw new ConflictError("QC execution unavailable");
      const context = step.qcContext;
      if (!context.deadlineAt) {
        const limits = ceiling(context.operation);
        const updated = {
          ...context,
          deadlineAt: new Date(Date.now() + (limits.maxRuntimeSeconds + 300) * 1000).toISOString(),
        };
        await tx
          .update(workflowSteps)
          .set({ qcContext: updated, updatedAt: new Date() })
          .where(eq(workflowSteps.id, stepId));
        return { ...step, qcContext: updated };
      }
      return { ...step, qcContext: context };
    });
    const limits = ceiling(step.qcContext.operation),
      ttl = limits.maxRuntimeSeconds + 300;
    const [canonical] = await this.db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, record.revision.canonicalArtifactId),
          eq(artifacts.organizationId, record.run.organizationId),
          eq(artifacts.projectId, record.projectId),
          eq(artifacts.datasetVersionId, record.run.datasetVersionId)
        )
      );
    if (!canonical || canonical.sha256 !== record.version.canonicalChecksum)
      throw new ConflictError("Canonical input conflict");
    let decision: QcDecision | null = null;
    let auxiliaryIds: string[] = [];
    if (step.qcContext.operation === "PREVIEW") {
      const qc = await this.step(record, record.revision.qcStepId);
      const metrics = qc.qcResult?.artifacts.find(
        (fact) => fact.fileName === "qc_metrics.jsonl.gz"
      );
      if (!metrics) throw new ConflictError("QC result required");
      auxiliaryIds = [metrics.artifactId];
    }
    if (step.qcContext.operation === "FILTER") {
      const [persisted] = await this.db
        .select()
        .from(qcDecisions)
        .where(
          and(
            eq(qcDecisions.id, step.qcContext.decisionId ?? ""),
            eq(qcDecisions.analysisRunId, runId),
            eq(qcDecisions.organizationId, record.run.organizationId)
          )
        );
      if (
        !persisted ||
        record.revision.decisionId !== persisted.id ||
        !validQcDecision(persisted.decision) ||
        persisted.decision.canonicalChecksum !== canonical.sha256 ||
        persisted.decision.qcRevision !== record.revision.qcRevision
      )
        throw new ConflictError("Approved QC Decision required");
      decision = persisted.decision;
      auxiliaryIds = [decision.preview.selectionArtifactId];
    }
    const auxiliaries = auxiliaryIds.length
      ? await this.db
          .select()
          .from(artifacts)
          .where(
            and(
              inArray(artifacts.id, auxiliaryIds),
              eq(artifacts.organizationId, record.run.organizationId),
              eq(artifacts.projectId, record.projectId),
              eq(artifacts.analysisRunId, runId)
            )
          )
      : [];
    if (auxiliaries.length !== auxiliaryIds.length)
      throw new ResourceNotFoundError("QC input unavailable");
    const targetNames = files(step.qcContext.operation);
    const targets = await Promise.all(
      targetNames.map((name, index) => {
        const id = step.qcContext.outputIds[index];
        if (!id) throw new ValidationError("QC target unavailable");
        const type = step.qcContext.operation === "FILTER" ? "FILTERED_DATASET" : "QC_REPORT";
        return this.storage.target(
          id,
          type,
          name,
          buildQcArtifactKey(record.run.organizationId, record.projectId, runId, id, name),
          ttl
        );
      })
    );
    const prepared = {
      schemaVersion: "1.0.0",
      environment: record.run.envelope.environment,
      analysisRunId: runId,
      stepId,
      submissionId: step.submissionId,
      pipelineVersion: record.run.pipelineVersion,
      operation: step.qcContext.operation,
      qcRevision: record.revision.qcRevision,
      deadlineAt: step.qcContext.deadlineAt,
      ceilings: limits,
      canonical: await this.storage.input(canonical, ttl),
      auxiliary: await Promise.all(auxiliaries.map((fact) => this.storage.input(fact, ttl))),
      targets,
      analysis: record.revision.analysisParameters,
      selection: step.qcContext.selection,
      decision: decision
        ? {
            decisionId: decision.id,
            canonicalChecksum: decision.canonicalChecksum,
            selectionArtifactId: decision.preview.selectionArtifactId,
            selectionChecksum: decision.preview.selectionChecksum,
            parametersChecksum: decision.preview.parametersChecksum,
            includedCount: decision.preview.includedCount,
            excludedCount: decision.preview.excludedCount,
          }
        : null,
    };
    if (!validQcPreparedExecution(prepared))
      throw new ValidationError("Invalid QC execution envelope");
    return prepared;
  }
  async provider(
    runId: string,
    stepId: string,
    providerJobId: string | undefined,
    state: unknown,
    executor: VerifiedExecutor
  ) {
    scope(executor, "execution.project");
    const record = await this.resolve(runId);
    const step = await this.step(record, stepId);
    const value = z
      .enum(["UNKNOWN", "PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"])
      .parse(state);
    if (
      (!providerJobId && value !== "CANCELLED") ||
      (providerJobId && (!providerJobId.trim() || providerJobId.length > 500))
    )
      throw new ValidationError("Invalid provider identity");
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.id, step.id))
        .for("update");
      if (!current || (current.providerJobId && current.providerJobId !== providerJobId))
        throw new ConflictError("Provider identity conflict");
      if (
        ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"].includes(current.providerState) &&
        current.providerState !== value
      )
        return { recorded: false };
      await tx
        .update(workflowSteps)
        .set({
          providerJobId: providerJobId ?? null,
          providerState: value,
          status:
            value === "CANCELLED"
              ? "CANCELLED"
              : current.status === "SUCCEEDED"
                ? "SUCCEEDED"
                : "RUNNING",
          attempt: current.attempt || 1,
          updatedAt: new Date(),
        })
        .where(eq(workflowSteps.id, step.id));
      return { recorded: true };
    });
  }
  async register(runId: string, input: unknown, executor: VerifiedExecutor) {
    scope(executor, "execution.finalize");
    if (!validQcJobResult(input) || input.analysisRunId !== runId)
      throw new ValidationError("Invalid QC output");
    const result: QcJobResult = input;
    const record = await this.resolve(runId);
    const step = await this.step(record, result.stepId);
    const operation = step.qcContext.operation;
    const [approval] =
      operation === "FILTER"
        ? await this.db
            .select()
            .from(qcDecisions)
            .where(
              and(
                eq(qcDecisions.id, step.qcContext.decisionId ?? ""),
                eq(qcDecisions.analysisRunId, runId),
                eq(qcDecisions.organizationId, record.run.organizationId)
              )
            )
        : [];
    if (operation === "FILTER" && !approval) throw new ConflictError("QC Decision required");
    await this.actor(record, approval?.actorId ?? record.run.actorId);
    if (
      result.operation !== operation ||
      result.submissionId !== step.submissionId ||
      result.artifacts.length !== files(operation).length ||
      result.artifacts.some(
        (fact, index) =>
          fact.artifactId !== step.qcContext.outputIds[index] ||
          fact.fileName !== files(operation)[index] ||
          fact.type !== (operation === "FILTER" ? "FILTERED_DATASET" : "QC_REPORT")
      )
    )
      throw new ConflictError("QC output authority conflict");
    if (
      operation === "QC" &&
      (!result.summary ||
        result.preview ||
        result.summary.cellCount !== record.version.cellCount ||
        result.summary.geneCount !== record.version.geneCount ||
        result.summary.randomSeed !== record.revision.analysisParameters.randomSeed)
    )
      throw new ConflictError("QC summary conflict");
    if (
      operation === "PREVIEW" &&
      (!result.preview ||
        result.summary ||
        !step.qcContext.selection ||
        result.preview.previewId !== step.id ||
        result.preview.qcRevision !== record.revision.qcRevision ||
        result.preview.canonicalChecksum !== record.version.canonicalChecksum ||
        result.preview.parametersChecksum !== qcSelectionChecksum(step.qcContext.selection) ||
        result.preview.selectionArtifactId !== result.artifacts[0]?.artifactId ||
        result.preview.selectionChecksum !== result.artifacts[0]?.sha256 ||
        result.preview.includedCount + result.preview.excludedCount !== record.version.cellCount)
    )
      throw new ConflictError("QC preview conflict");
    if (operation === "FILTER" && (result.summary || result.preview))
      throw new ConflictError("Filtered result conflict");
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, runId))
        .for("update");
      const [revision] = await tx
        .select()
        .from(qcRevisions)
        .where(eq(qcRevisions.analysisRunId, runId))
        .for("update");
      const [current] = await tx
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.id, step.id))
        .for("update");
      if (!run || !revision || !current) throw new ResourceNotFoundError("QC output unavailable");
      if (current.qcResult) {
        if (!isDeepStrictEqual(current.qcResult, result))
          throw new ConflictError("QC output replay conflict");
        return { registered: true };
      }
      if (run.cancelRequested || terminal(run.status))
        throw new ConflictError("QC execution cancelled");
      let decision: QcDecision | null = null;
      if (operation === "FILTER") {
        const [bound] = await tx
          .select()
          .from(qcDecisions)
          .where(
            and(
              eq(qcDecisions.id, step.qcContext.decisionId ?? ""),
              eq(qcDecisions.analysisRunId, runId),
              eq(qcDecisions.organizationId, run.organizationId)
            )
          );
        if (!bound || bound.id !== revision.decisionId)
          throw new ConflictError("Decision conflict");
        decision = bound.decision;
      }
      for (const fact of result.artifacts) {
        await tx.insert(artifacts).values({
          id: fact.artifactId,
          organizationId: run.organizationId,
          projectId: run.projectId,
          datasetVersionId: run.datasetVersionId,
          analysisRunId: runId,
          workflowStepId: step.id,
          artifactType: fact.type,
          bucket: this.storage.bucket(),
          objectKey: buildQcArtifactKey(
            run.organizationId,
            run.projectId,
            runId,
            fact.artifactId,
            fact.fileName
          ),
          sha256: fact.sha256,
          sizeBytes: fact.byteSize,
          mimeType: fact.fileName.endsWith("h5ad")
            ? "application/x-hdf5"
            : fact.fileName.endsWith("gz")
              ? "application/gzip"
              : "application/json",
          pipelineVersion: run.pipelineVersion,
          metadata: {
            fileName: fact.fileName,
            operation,
            qcRevision: revision.qcRevision,
            ...(decision ? { decisionId: decision.id } : {}),
          },
        });
        const parents = [revision.canonicalArtifactId];
        if (operation !== "QC") {
          const [qc] = await tx
            .select()
            .from(workflowSteps)
            .where(eq(workflowSteps.id, revision.qcStepId));
          for (const parent of qc?.qcResult?.artifacts ?? []) parents.push(parent.artifactId);
        }
        if (decision) parents.push(decision.preview.selectionArtifactId);
        for (const parent of [...new Set(parents)])
          await tx.insert(artifactLineage).values({
            organizationId: run.organizationId,
            projectId: run.projectId,
            analysisRunId: runId,
            parentArtifactId: parent,
            childArtifactId: fact.artifactId,
            relationship: decision ? "filtered_with_decision" : "derived_from",
          });
      }
      await tx
        .update(workflowSteps)
        .set({
          qcResult: result,
          status: "SUCCEEDED",
          updatedAt: new Date(),
          provenance: {
            ...current.provenance,
            pipelineVersion: run.pipelineVersion,
            providerJobId: current.providerJobId,
            completedAt: new Date().toISOString(),
            geneSetPolicy: record.revision.analysisParameters.geneSetPolicy,
            scrubletProfile: record.revision.analysisParameters.scrubletProfile,
            ...(decision ? { decisionId: decision.id } : {}),
          },
        })
        .where(eq(workflowSteps.id, step.id));
      if (operation === "FILTER")
        await tx
          .update(qcRevisions)
          .set({ filterCommitted: true, approvalPending: false })
          .where(eq(qcRevisions.analysisRunId, runId));
      if (operation !== "PREVIEW")
        await tx.insert(auditEvents).values({
          id: generateDomainId("aud"),
          organizationId: run.organizationId,
          actorType: "system",
          actorId: run.actorId,
          action: operation === "QC" ? "qc.review_completed" : "qc.filter_completed",
          resourceType: "analysis_run",
          resourceId: runId,
          metadata: { stepId: step.id, ...(decision ? { decisionId: decision.id } : {}) },
        });
      return { registered: true };
    });
  }
  async preview(context: TenantContext, runId: string, input: unknown, key: string) {
    const record = await this.authorize(context, runId, true);
    if (!validQcSelectionParameters(input)) throw new ValidationError("Invalid QC selection");
    const selection: QcSelectionParameters = structuredClone(input);
    const ruleKeys = new Set(
      selection.thresholds.map((rule) => JSON.stringify([rule.metric, rule.sampleKey]))
    );
    if (
      ruleKeys.size !== selection.thresholds.length ||
      selection.thresholds.some(
        (rule) =>
          rule.sampleKey !== null &&
          !record.revision.analysisParameters.samples.some(
            (sample) => sample.sampleKey === rule.sampleKey
          )
      )
    )
      throw new ValidationError("Invalid sample-specific QC selection");
    for (const rule of selection.thresholds)
      if (
        (rule.minimum === null && rule.maximum === null) ||
        (rule.minimum !== null && rule.maximum !== null && rule.minimum > rule.maximum) ||
        Object.is(rule.minimum, -0) ||
        Object.is(rule.maximum, -0)
      )
        throw new ValidationError("Invalid threshold bounds");
    const identity = requestKey(key),
      digest = qcSelectionChecksum(selection);
    const result = await this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, runId))
        .for("update");
      const [rev] = await tx
        .select()
        .from(qcRevisions)
        .where(eq(qcRevisions.analysisRunId, runId))
        .for("update");
      if (
        !run ||
        !rev ||
        run.cancelRequested ||
        run.status !== "QC_REVIEW_REQUIRED" ||
        rev.decisionId
      )
        throw new ConflictError("QC review unavailable");
      const [old] = await tx
        .select()
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.analysisRunId, runId),
            eq(workflowSteps.stepKey, `preview-request:${context.userId}:${identity}`)
          )
        );
      if (old) {
        if (old.provenance.requestChecksum !== digest)
          throw new ConflictError("Preview request conflict");
        return { previewId: old.id };
      }
      // Control snapshots are bounded to 1000 steps, including QC and FILTER.
      if (rev.previewRevision >= 998) throw new ConflictError("QC review revision limit reached");
      const stepId = generateDomainId("wfs"),
        revision = rev.previewRevision + 1;
      await tx.insert(workflowSteps).values({
        id: stepId,
        organizationId: run.organizationId,
        analysisRunId: runId,
        stepKey: `preview-request:${context.userId}:${identity}`,
        stepVersion: run.pipelineVersion,
        submissionId: `${runId}:preview:${revision}`,
        qcContext: stepContext("PREVIEW", revision, selection),
        provenance: { requestChecksum: digest },
      });
      await tx
        .update(qcRevisions)
        .set({ previewStepId: stepId, previewRevision: revision })
        .where(eq(qcRevisions.analysisRunId, runId));
      return { previewId: stepId };
    });
    await this.signal(record.run.temporalWorkflowId, "previewQC", {
      schemaVersion: "1.0.0",
      analysisRunId: runId,
    }).catch(() => undefined);
    return result;
  }
  async approve(context: TenantContext, runId: string, input: unknown, key: string) {
    const record = await this.authorize(context, runId, true);
    if (!validQcApprovalRequest(input)) throw new ValidationError("Invalid QC confirmation");
    if (!input.reason.trim()) throw new ValidationError("QC confirmation reason required");
    const request: QcApprovalRequest = input,
      identity = requestKey(key),
      digest = hash(request);
    const decision = await this.db.transaction(async (tx) => {
      const memberships = await tx
        .select({ role: member.role })
        .from(member)
        .where(
          and(eq(member.organizationId, context.organizationId), eq(member.userId, context.userId))
        );
      const role = memberships.length === 1 ? memberships[0]?.role : null;
      if (
        role !== context.role ||
        !["owner", "admin", "bioinformatician", "scientist"].includes(role ?? "")
      )
        throw new TenantAuthorizationError("QC approval unavailable");
      if (role !== "owner" && role !== "admin") {
        const assignments = await tx
          .select({ id: projectMembers.id })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.organizationId, context.organizationId),
              eq(projectMembers.projectId, record.projectId),
              eq(projectMembers.userId, context.userId)
            )
          );
        if (!assignments.length) throw new TenantAuthorizationError("QC approval unavailable");
      }
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, runId))
        .for("update");
      const [rev] = await tx
        .select()
        .from(qcRevisions)
        .where(eq(qcRevisions.analysisRunId, runId))
        .for("update");
      if (
        !run ||
        !rev ||
        run.cancelRequested ||
        run.status === "CANCELLED" ||
        run.status === "CANCEL_REQUESTED"
      )
        throw new ConflictError("QC review cancelled");
      if (rev.decisionId) {
        const [old] = await tx.select().from(qcDecisions).where(eq(qcDecisions.id, rev.decisionId));
        if (old?.actorId === context.userId && old.requestChecksum === digest) return old.decision;
        throw new ConflictError("QC Decision already immutable");
      }
      if (run.status !== "QC_REVIEW_REQUIRED" || rev.previewStepId !== request.previewId)
        throw new ConflictError("Stale QC preview");
      const [preview] = await tx
        .select()
        .from(workflowSteps)
        .where(
          and(
            eq(workflowSteps.id, request.previewId),
            eq(workflowSteps.analysisRunId, runId),
            eq(workflowSteps.organizationId, run.organizationId)
          )
        )
        .for("update");
      const proof = preview?.qcResult?.preview,
        selection = preview?.qcContext?.selection;
      if (
        !preview ||
        preview.status !== "SUCCEEDED" ||
        !proof ||
        !selection ||
        proof.qcRevision !== rev.qcRevision ||
        proof.canonicalChecksum !== record.version.canonicalChecksum ||
        proof.parametersChecksum !== qcSelectionChecksum(selection)
      )
        throw new ConflictError("Trusted current selection preview required");
      const [artifact] = await tx
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.id, proof.selectionArtifactId),
            eq(artifacts.organizationId, run.organizationId),
            eq(artifacts.analysisRunId, runId),
            eq(artifacts.workflowStepId, preview.id)
          )
        );
      if (!artifact || artifact.sha256 !== proof.selectionChecksum)
        throw new ConflictError("Selection artifact conflict");
      const decision: QcDecision = {
        schemaVersion: "1.0.0",
        id: generateDomainId("qcd"),
        organizationId: run.organizationId,
        projectId: run.projectId,
        analysisRunId: runId,
        datasetVersionId: run.datasetVersionId,
        canonicalChecksum: proof.canonicalChecksum,
        qcRevision: rev.qcRevision,
        preview: proof,
        selection,
        actorId: context.userId,
        createdAt: new Date().toISOString(),
        reason: request.reason,
        geneSetPolicy: rev.analysisParameters.geneSetPolicy,
        scrubletProfile: rev.analysisParameters.scrubletProfile,
      };
      if (!validQcDecision(decision)) throw new ValidationError("Invalid QC Decision");
      await tx.insert(qcDecisions).values({
        id: decision.id,
        organizationId: run.organizationId,
        projectId: run.projectId,
        analysisRunId: runId,
        datasetVersionId: run.datasetVersionId,
        qcRevision: rev.qcRevision,
        previewStepId: preview.id,
        selectionArtifactId: artifact.id,
        actorId: context.userId,
        requestKey: identity,
        requestChecksum: digest,
        decision,
      });
      await tx.insert(workflowSteps).values({
        id: generateDomainId("wfs"),
        organizationId: run.organizationId,
        analysisRunId: runId,
        stepKey: `filter:${decision.id}`,
        stepVersion: run.pipelineVersion,
        submissionId: `${runId}:filter:${decision.id}`,
        qcContext: stepContext("FILTER", rev.qcRevision, selection, decision.id),
      });
      await tx
        .update(qcRevisions)
        .set({ decisionId: decision.id, approvalPending: true })
        .where(eq(qcRevisions.analysisRunId, runId));
      await tx.insert(auditEvents).values({
        id: generateDomainId("aud"),
        organizationId: run.organizationId,
        actorType: "user",
        actorId: context.userId,
        action: "qc.decision_approved",
        resourceType: "qc_decision",
        resourceId: decision.id,
        metadata: { analysisRunId: runId, previewId: preview.id },
      });
      return decision;
    });
    await this.deliverDecision(record.run.temporalWorkflowId, runId, decision.id).catch(
      () => undefined
    );
    return decision;
  }
  async deliverDecision(workflowId: string, runId: string, decisionId: string) {
    await this.signal(workflowId, "confirmQC", {
      schemaVersion: "1.0.0",
      analysisRunId: runId,
      decisionId,
    });
    await this.db
      .update(qcRevisions)
      .set({ approvalPending: false })
      .where(and(eq(qcRevisions.analysisRunId, runId), eq(qcRevisions.decisionId, decisionId)));
  }
  async signal(workflowId: string, name: string, payload: unknown) {
    const client = await getTemporalClientService().getClient();
    await client.workflow.getHandle(workflowId).signal(name, payload);
  }
  async project(input: unknown, executor: VerifiedExecutor) {
    scope(executor, "execution.project");
    if (!validQcProjection(input)) throw new ValidationError("Invalid QC projection");
    const record = await this.resolve(input.analysisRunId);
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, record.run.id))
        .for("update");
      const [revision] = await tx
        .select()
        .from(qcRevisions)
        .where(eq(qcRevisions.analysisRunId, record.run.id))
        .for("update");
      if (!run || !revision) throw new ResourceNotFoundError("QC unavailable");
      if (input.sequence <= run.projectionVersion) return { applied: false };
      const allowed: readonly RunState[] = RUN_TRANSITIONS[run.status];
      if (run.status !== input.status && !allowed.includes(input.status))
        throw new ConflictError("Invalid QC transition");
      if (input.status === "SUCCEEDED" && !revision.filterCommitted)
        throw new ConflictError("Filtered artifact commit required");
      if (input.status === "QC_REVIEW_REQUIRED") {
        const [qc] = await tx
          .select()
          .from(workflowSteps)
          .where(eq(workflowSteps.id, revision.qcStepId));
        if (!qc?.qcResult?.summary) throw new ConflictError("QC computation required");
      }
      if (input.status === "CANCELLED" && revision.filterCommitted)
        throw new ConflictError("Filter commit wins cancellation");
      await tx
        .update(analysisRuns)
        .set({ status: input.status, projectionVersion: input.sequence, updatedAt: new Date() })
        .where(eq(analysisRuns.id, run.id));
      if (input.status === "CANCELLED" && run.status !== "CANCELLED")
        await tx.insert(auditEvents).values({
          id: generateDomainId("aud"),
          organizationId: run.organizationId,
          actorType: "user",
          actorId: revision.cancelActorId ?? run.actorId,
          action: "qc.cancelled",
          resourceType: "analysis_run",
          resourceId: run.id,
          metadata: {},
        });
      return { applied: true };
    });
  }
  async cancel(context: TenantContext, runId: string) {
    const record = await this.authorize(context, runId, true);
    const outcome = await this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(analysisRuns)
        .where(eq(analysisRuns.id, runId))
        .for("update");
      const [rev] = await tx
        .select()
        .from(qcRevisions)
        .where(eq(qcRevisions.analysisRunId, runId))
        .for("update");
      if (!run || !rev) throw new ResourceNotFoundError("QC unavailable");
      if (terminal(run.status) || rev.filterCommitted) return { tooLate: true };
      if (run.cancelRequested) return { tooLate: false };
      await tx
        .update(qcRevisions)
        .set({ cancelActorId: context.userId })
        .where(eq(qcRevisions.analysisRunId, runId));
      await tx
        .update(analysisRuns)
        .set({ cancelRequested: true, status: "CANCEL_REQUESTED", updatedAt: new Date() })
        .where(eq(analysisRuns.id, runId));
      return { tooLate: false };
    });
    if (!outcome.tooLate) {
      try {
        await (
          await getTemporalClientService().getClient()
        ).workflow
          .getHandle(record.run.temporalWorkflowId)
          .cancel();
      } catch {
        /* persisted intent reconciles */
      }
    }
    return outcome;
  }
  async review(context: TenantContext, runId: string) {
    const record = await this.authorize(context, runId);
    const control = await this.control(runId, {
      subject: "cellweave-orchestrator",
      scopes: ["execution.prepare"],
    });
    const qc = control.steps.find((step) => step.stepId === record.revision.qcStepId);
    const preview = control.steps.find((step) => step.stepId === record.revision.previewStepId);
    return {
      filteredArtifactId:
        control.steps.find((step) => step.context.operation === "FILTER")?.result?.artifacts[0]
          ?.artifactId ?? null,
      canApprove: context.role !== "viewer",
      analysisRunId: runId,
      datasetVersionId: record.run.datasetVersionId,
      status: record.run.status,
      qcRevision: record.revision.qcRevision,
      summary: qc?.result?.summary ?? null,
      preview: preview?.result?.preview ?? null,
      previewError: preview?.status === "FAILED" ? "QC_SELECTION_REJECTED" : null,
      previewPending:
        preview !== undefined && preview.status !== "SUCCEEDED" && preview.status !== "FAILED",
      previewParameters: preview?.context.selection ?? null,
      decision: control.decision,
    };
  }
  async artifactUrl(context: TenantContext, runId: string, artifactId: string) {
    const record = await this.authorize(context, runId);
    const [artifact] = await this.db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, artifactId),
          eq(artifacts.organizationId, context.organizationId),
          eq(artifacts.projectId, record.projectId),
          eq(artifacts.analysisRunId, runId)
        )
      );
    if (!artifact) throw new ResourceNotFoundError("Artifact unavailable");
    return { downloadUrl: await this.storage.download(artifact.objectKey, 300) };
  }

  async reconcile(executor: VerifiedExecutor) {
    scope(executor, "execution.prepare");
    scope(executor, "execution.project");
    const rows = await this.db
      .select({ run: analysisRuns, revision: qcRevisions })
      .from(analysisRuns)
      .innerJoin(qcRevisions, eq(qcRevisions.analysisRunId, analysisRuns.id))
      .where(
        and(
          eq(analysisRuns.kind, "QC"),
          notInArray(analysisRuns.status, ["SUCCEEDED", "FAILED", "CANCELLED"])
        )
      )
      .orderBy(asc(analysisRuns.updatedAt))
      .limit(100);
    for (const { run, revision } of rows) {
      try {
        if (run.status === "START_PENDING" || run.status === "CANCEL_REQUESTED")
          await this.start(run.id);
        if (revision.decisionId && revision.approvalPending)
          await this.deliverDecision(run.temporalWorkflowId, run.id, revision.decisionId);
        if (!revision.approvalPending && !run.cancelRequested) {
          const client = await getTemporalClientService().getClient();
          const handle = client.workflow.getHandle(run.temporalWorkflowId);
          // Queries do not append history. Idle human review receives no periodic signals.
          if (
            (await client.connection.withDeadline(Date.now() + 5000, () =>
              handle.query("qcNeedsReconciliation")
            )) === true
          )
            await this.signal(run.temporalWorkflowId, "reconcileQC", {
              schemaVersion: "1.0.0",
              analysisRunId: run.id,
            });
          else if (run.status === "QC_REVIEW_REQUIRED" && revision.previewStepId) {
            const preview = await this.step(await this.resolve(run.id), revision.previewStepId);
            if (
              !preview.qcResult &&
              preview.status !== "FAILED" &&
              preview.status !== "CANCELLED" &&
              (await client.connection.withDeadline(Date.now() + 5000, () =>
                handle.query("qcWaiting")
              )) === true
            )
              await this.signal(run.temporalWorkflowId, "previewQC", {
                schemaVersion: "1.0.0",
                analysisRunId: run.id,
              });
          }
        }
        if (run.cancelRequested && !revision.filterCommitted)
          await (
            await getTemporalClientService().getClient()
          ).workflow
            .getHandle(run.temporalWorkflowId)
            .cancel();
      } catch {
        /* bounded retry retains authoritative intent */
      } finally {
        await this.db
          .update(analysisRuns)
          .set({ updatedAt: new Date() })
          .where(eq(analysisRuns.id, run.id))
          .catch(() => undefined);
      }
    }
    return { examined: rows.length };
  }
  async decision(runId: string, decisionId: string, executor: VerifiedExecutor) {
    scope(executor, "execution.prepare");
    const record = await this.resolve(runId);
    const [row] = await this.db
      .select()
      .from(qcDecisions)
      .where(
        and(
          eq(qcDecisions.id, decisionId),
          eq(qcDecisions.analysisRunId, runId),
          eq(qcDecisions.organizationId, record.run.organizationId)
        )
      );
    if (
      !row ||
      record.revision.decisionId !== decisionId ||
      record.run.cancelRequested ||
      row.decision.qcRevision !== record.revision.qcRevision ||
      row.decision.canonicalChecksum !== record.version.canonicalChecksum ||
      !validQcDecision(row.decision)
    )
      throw new ConflictError("QC Decision unavailable");
    await this.actor(record, row.actorId);
    return row.decision;
  }
  async stepFailed(runId: string, stepId: string, executor: VerifiedExecutor) {
    scope(executor, "execution.project");
    const record = await this.resolve(runId);
    const step = await this.step(record, stepId);
    if (step.qcContext.operation !== "PREVIEW" || step.qcResult)
      throw new ConflictError("Invalid failed preview");
    await this.db
      .update(workflowSteps)
      .set({
        status: "FAILED",
        updatedAt: new Date(),
        provenance: { ...step.provenance, failureCode: "QC_SELECTION_REJECTED" },
      })
      .where(eq(workflowSteps.id, stepId));
    return { recorded: true };
  }

  async inputOptions(context: TenantContext) {
    const rows = await this.db
      .select({
        datasetVersionId: datasetVersions.id,
        version: datasetVersions.versionNumber,
        name: datasets.name,
        projectName: projects.name,
        projectId: projects.id,
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
      .leftJoin(
        projectMembers,
        and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.organizationId, context.organizationId),
          eq(projectMembers.userId, context.userId)
        )
      )
      .where(
        and(
          eq(datasetVersions.organizationId, context.organizationId),
          isNotNull(datasetVersions.canonicalChecksum),
          eq(projects.status, "active"),
          context.role === "owner" || context.role === "admin"
            ? undefined
            : isNotNull(projectMembers.id)
        )
      )
      .orderBy(desc(datasetVersions.createdAt))
      .limit(100);
    const result = [];
    for (const row of rows) {
      const registered = await this.db
        .select({ sampleId: samples.id, sampleKey: samples.sampleKey, label: samples.displayName })
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
            eq(experiments.projectId, row.projectId)
          )
        )
        .limit(1000);
      result.push({
        datasetVersionId: row.datasetVersionId,
        label: `${row.projectName} / ${row.name} / v${row.version}`,
        samples: registered.map((value) => ({ ...value, label: value.label ?? value.sampleKey })),
      });
    }
    return { canStart: context.role !== "viewer", datasets: result };
  }
}

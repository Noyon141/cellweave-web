import "server-only";
import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import type { ExecutionResult } from "@cellweave/contracts";
import { analysisRuns, workflowSteps } from "../database/schema";
import { ExecutionService, type VerifiedExecutor } from "./execution-service";
import { validResult } from "./execution-validation";
import { ConflictError, ValidationError } from "../authorization/errors";
import { finalizePublishedDatasetImport } from "./published-dataset-import-finalization";
export async function finalizeExecution(
  service: ExecutionService,
  runId: string,
  input: unknown,
  executor: VerifiedExecutor
) {
  if (!validResult(input)) throw new ValidationError("Invalid execution result");
  const result: ExecutionResult = input;
  const record = await service.resolve(runId, executor, "execution.finalize");
  if (
    result.canonicalization.sourceFormat !== record.versionSourceFormat ||
    result.canonicalization.organism !== record.run.envelope.organism ||
    result.canonicalization.geneIdScheme !== record.run.envelope.geneIdScheme ||
    (result.canonicalization.referenceBuild ?? null) !== record.run.envelope.referenceBuild ||
    result.analysisRunId !== runId ||
    result.submissionId !== record.step.submissionId ||
    result.publication.datasetVersionId !== record.run.datasetVersionId ||
    result.publication.canonicalChecksum !== result.canonicalization.canonicalChecksum
  )
    throw new ConflictError("Execution result conflict");
  if (record.step.result) {
    if (!isDeepStrictEqual(record.step.result, result))
      throw new ConflictError("Execution result conflict");
    return { finalized: true };
  }
  const context = await service.actor(record);
  await service.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(analysisRuns)
      .where(eq(analysisRuns.id, runId))
      .for("update");
    const [currentStep] = await tx
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, record.step.id))
      .for("update");
    if (!current || !currentStep || (current.cancelRequested && !currentStep.finalizationStarted))
      throw new ConflictError("Execution cancelled before commit boundary");
    await tx
      .update(workflowSteps)
      .set({ finalizationStarted: true })
      .where(eq(workflowSteps.id, record.step.id));
  });
  await finalizePublishedDatasetImport({
    context,
    datasetVersionId: record.run.datasetVersionId,
    publicationResult: result.publication,
    scientificFacts: {
      organism: result.canonicalization.organism,
      geneIdScheme: result.canonicalization.geneIdScheme,
      referenceBuild: result.canonicalization.referenceBuild ?? null,
      cellCount: result.canonicalization.cellCount,
      geneCount: result.canonicalization.geneCount,
    },
  });
  await service.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.id, record.step.id))
      .for("update");
    if (!current || (current.result && !isDeepStrictEqual(current.result, result)))
      throw new ConflictError("Execution result conflict");
    await tx
      .update(workflowSteps)
      .set({
        result,
        provenance: {
          ...current.provenance,
          pipelineVersion: record.run.pipelineVersion,
          submissionId: record.step.submissionId,
          providerJobId: current.providerJobId,
          canonicalChecksum: result.publication.canonicalChecksum,
          ...(result.usage ? { usage: result.usage } : {}),
        },
        updatedAt: new Date(),
      })
      .where(eq(workflowSteps.id, record.step.id));
  });
  return { finalized: true };
}

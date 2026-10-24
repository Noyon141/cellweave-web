import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { ServiceScope } from "@cellweave/contracts";
import {
  getServiceTokenVerifier,
  ServiceAuthenticationError,
  ServiceVerificationConfigurationError,
} from "@/server/authorization/service-token";
import { finalizeExecution } from "@/server/services/execution-finalization";
import { ExecutionService } from "@/server/services/execution-service";
import {
  DatasetImportFinalizationConflictError,
  DatasetImportFinalizationSecurityError,
  DatasetImportFinalizationConfigurationError,
  DatasetImportFinalizationDatabaseError,
} from "@/server/services/dataset-import-finalization-errors";
import { handleRouteError } from "@/server/api/error-handler";
const scopes: Record<string, readonly ServiceScope[]> = {
  prepare: ["execution.prepare", "capability.issue"],
  control: ["execution.prepare"],
  project: ["execution.project"],
  provider: ["execution.project"],
  finalize: ["execution.finalize"],
  cancel: ["execution.cancel", "execution.project"],
  reconcile: ["execution.prepare", "execution.project"],
};
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string; operation: string }> }
) {
  try {
    const { runId, operation } = await params;
    const required = scopes[operation];
    if (!required) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const executor = await (
      await getServiceTokenVerifier()
    ).verify(request.headers.get("authorization"), required);
    const service = new ExecutionService();
    let data: unknown;
    if (operation === "prepare") data = await service.prepare(runId, executor);
    else if (operation === "control") data = await service.control(runId, executor);
    else if (operation === "reconcile") data = await service.reconcileStarts(executor);
    else if (operation === "project") {
      const input: unknown = await request.json();
      if (
        !input ||
        typeof input !== "object" ||
        !("analysisRunId" in input) ||
        input.analysisRunId !== runId
      )
        return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
      data = await service.project(input, executor);
    } else if (operation === "provider" || operation === "cancel") {
      const body = z
        .object({
          providerJobId: z.string().min(1).optional(),
          providerState: z.enum([
            "UNKNOWN",
            "PENDING",
            "RUNNING",
            "COMPLETED",
            "FAILED",
            "CANCELLED",
            "TIMEOUT",
          ]),
        })
        .strict()
        .parse(await request.json());
      if (operation === "cancel" && body.providerState !== "CANCELLED")
        return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
      data = await service.mapProvider(runId, body.providerJobId, body.providerState, executor);
    } else data = await finalizeExecution(service, runId, await request.json(), executor);
    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof DatasetImportFinalizationConflictError)
      return NextResponse.json({ error: "FINALIZATION_CONFLICT" }, { status: 409 });
    if (error instanceof DatasetImportFinalizationSecurityError)
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    if (
      error instanceof DatasetImportFinalizationConfigurationError ||
      error instanceof DatasetImportFinalizationDatabaseError
    )
      return NextResponse.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503 });

    if (error instanceof ServiceAuthenticationError)
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    if (error instanceof ServiceVerificationConfigurationError)
      return NextResponse.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503 });
    // Never pass raw transport/SQL/cryptographic errors into the general logging path.
    if (
      error instanceof Error &&
      !(error instanceof z.ZodError) &&
      ![
        "ResourceNotFoundError",
        "TenantAuthorizationError",
        "ValidationError",
        "ConflictError",
      ].includes(error.name)
    )
      return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
    return handleRouteError(error);
  }
}

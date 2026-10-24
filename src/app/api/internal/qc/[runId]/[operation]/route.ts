import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { ServiceScope } from "@cellweave/contracts";
import {
  getServiceTokenVerifier,
  ServiceAuthenticationError,
  ServiceVerificationConfigurationError,
} from "@/server/authorization/service-token";
import { readQcBody } from "@/server/api/qc-body";
import { handleRouteError } from "@/server/api/error-handler";
import { QcService } from "@/server/services/qc-service";
const scopes: Record<string, readonly ServiceScope[]> = {
  control: ["execution.prepare"],
  prepare: ["execution.prepare", "capability.issue"],
  provider: ["execution.project"],
  register: ["execution.finalize"],
  project: ["execution.project"],
  decision: ["execution.prepare"],
  "step-failed": ["execution.project"],
  reconcile: ["execution.prepare", "execution.project"],
};
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string; operation: string }> }
) {
  try {
    const { runId, operation } = await params;
    const required = Object.hasOwn(scopes, operation) ? scopes[operation] : undefined;
    if (!required) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const executor = await (
      await getServiceTokenVerifier()
    ).verify(request.headers.get("authorization"), required);
    const service = new QcService();
    let data: unknown;
    if (operation === "control") data = await service.control(runId, executor);
    else if (operation === "reconcile") data = await service.reconcile(executor);
    else {
      const body = await readQcBody(request, 4 * 1024 * 1024);
      if (operation === "register") data = await service.register(runId, body, executor);
      else if (operation === "project") {
        const input = z
          .object({
            analysisRunId: z.literal(runId),
            sequence: z.number().int().positive(),
            status: z.string(),
          })
          .strict()
          .parse(body);
        data = await service.project(input, executor);
      } else if (operation === "decision") {
        const input = z
          .object({ decisionId: z.string().min(1) })
          .strict()
          .parse(body);
        data = await service.decision(runId, input.decisionId, executor);
      } else if (operation === "provider") {
        const input = z
          .object({
            stepId: z.string().min(1),
            providerJobId: z.string().min(1).optional(),
            state: z.string(),
          })
          .strict()
          .parse(body);
        data = await service.provider(
          runId,
          input.stepId,
          input.providerJobId,
          input.state,
          executor
        );
      } else {
        const input = z
          .object({ stepId: z.string().min(1) })
          .strict()
          .parse(body);
        data =
          operation === "prepare"
            ? await service.prepare(runId, input.stepId, executor)
            : await service.stepFailed(runId, input.stepId, executor);
      }
    }
    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof ServiceAuthenticationError)
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    if (error instanceof ServiceVerificationConfigurationError)
      return NextResponse.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503 });
    return handleRouteError(error);
  }
}

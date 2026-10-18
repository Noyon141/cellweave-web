import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { ExperimentService, createExperimentSchema } from "@/server/services/experiment-service";
import { handleRouteError } from "@/server/api/error-handler";
import { extractRequestAuditMetadata } from "@/server/api/request-metadata";

interface RouteParams {
  params: Promise<{ projectId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { projectId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });

    const service = new ExperimentService();
    const data = await service.listProjectExperiments(context, projectId);

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { projectId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const rawBody = await request.json();
    const validatedBody = createExperimentSchema.parse(rawBody);
    const requestMetadata = extractRequestAuditMetadata(request);

    const service = new ExperimentService();
    const data = await service.createExperiment(context, projectId, validatedBody, {
      requestMetadata,
    });

    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

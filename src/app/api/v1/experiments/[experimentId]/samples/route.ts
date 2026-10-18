import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { SampleService, createSampleSchema } from "@/server/services/sample-service";
import { handleRouteError } from "@/server/api/error-handler";
import { extractRequestAuditMetadata } from "@/server/api/request-metadata";

interface RouteParams {
  params: Promise<{ experimentId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { experimentId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });

    const service = new SampleService();
    const data = await service.listExperimentSamples(context, experimentId);

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { experimentId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const rawBody = await request.json();
    const validatedBody = createSampleSchema.parse(rawBody);
    const requestMetadata = extractRequestAuditMetadata(request);

    const service = new SampleService();
    const data = await service.createSample(context, experimentId, validatedBody, {
      requestMetadata,
    });

    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

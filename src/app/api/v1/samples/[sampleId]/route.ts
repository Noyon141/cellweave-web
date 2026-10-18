import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { SampleService, updateSampleSchema } from "@/server/services/sample-service";
import { handleRouteError } from "@/server/api/error-handler";
import { extractRequestAuditMetadata } from "@/server/api/request-metadata";

interface RouteParams {
  params: Promise<{ sampleId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { sampleId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });

    const service = new SampleService();
    const data = await service.getSample(context, sampleId);

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { sampleId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const rawBody = await request.json();
    const validatedBody = updateSampleSchema.parse(rawBody);
    const requestMetadata = extractRequestAuditMetadata(request);

    const service = new SampleService();
    const data = await service.updateSample(context, sampleId, validatedBody, {
      requestMetadata,
    });

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { DatasetService, createDatasetVersionSchema } from "@/server/services/dataset-service";
import { handleRouteError } from "@/server/api/error-handler";
import { extractRequestAuditMetadata } from "@/server/api/request-metadata";

interface RouteParams {
  params: Promise<{ datasetId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { datasetId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });

    const service = new DatasetService();
    const data = await service.listDatasetVersions(context, datasetId);

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { datasetId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const rawBody = await request.json();
    const validatedBody = createDatasetVersionSchema.parse(rawBody);
    const requestMetadata = extractRequestAuditMetadata(request);

    const service = new DatasetService();
    const data = await service.createDatasetVersion(context, datasetId, validatedBody, {
      requestMetadata,
    });

    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { DatasetService } from "@/server/services/dataset-service";
import { handleRouteError } from "@/server/api/error-handler";

interface RouteParams {
  params: Promise<{ datasetVersionId: string }>;
}

/**
 * GET /api/v1/dataset-versions/[datasetVersionId]
 * Dataset versions are strictly immutable.
 * Updates (PATCH/PUT) and deletions (DELETE) are prohibited.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { datasetVersionId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });

    const service = new DatasetService();
    const data = await service.getDatasetVersion(context, datasetVersionId);

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

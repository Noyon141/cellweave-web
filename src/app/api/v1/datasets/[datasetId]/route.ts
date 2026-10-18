import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { DatasetService } from "@/server/services/dataset-service";
import { handleRouteError } from "@/server/api/error-handler";

interface RouteParams {
  params: Promise<{ datasetId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { datasetId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });

    const service = new DatasetService();
    const data = await service.getDataset(context, datasetId);

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { handleRouteError } from "@/server/api/error-handler";
import { QcService } from "@/server/services/qc-service";
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const context = await resolveTenantContext({ requestOrHeaders: request });
    return NextResponse.json({ data: await new QcService().review(context, (await params).runId) });
  } catch (error) {
    return handleRouteError(error);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { ExecutionService } from "@/server/services/execution-service";
import { handleRouteError } from "@/server/api/error-handler";
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const { runId } = await params;
    return NextResponse.json(
      { data: await new ExecutionService().cancel(context, runId) },
      { status: 202 }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

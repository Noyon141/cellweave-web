import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { handleRouteError } from "@/server/api/error-handler";
import { readQcBody } from "@/server/api/qc-body";
import { QcService } from "@/server/services/qc-service";
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string; operation: string }> }
) {
  try {
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const { runId, operation } = await params;
    const service = new QcService();
    if (operation === "cancel")
      return NextResponse.json({ data: await service.cancel(context, runId) });
    if (operation !== "preview" && operation !== "approve")
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const body = await readQcBody(request);
    return NextResponse.json(
      {
        data: await service[operation](
          context,
          runId,
          body,
          request.headers.get("idempotency-key") ?? ""
        ),
      },
      { status: operation === "preview" ? 202 : 200 }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string; operation: string }> }
) {
  try {
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const { runId, operation } = await params;
    if (operation !== "artifact") return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json({
      data: await new QcService().artifactUrl(
        context,
        runId,
        request.nextUrl.searchParams.get("artifactId") ?? ""
      ),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

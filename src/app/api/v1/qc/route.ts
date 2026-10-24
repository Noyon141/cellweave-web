import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { handleRouteError } from "@/server/api/error-handler";
import { readQcBody } from "@/server/api/qc-body";
import { QcService } from "@/server/services/qc-service";
export async function POST(request: NextRequest) {
  try {
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const input = await readQcBody(request);
    const data = await new QcService().create(
      context,
      input,
      request.headers.get("idempotency-key") ?? ""
    );
    return NextResponse.json({ data }, { status: 202 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const context = await resolveTenantContext({ requestOrHeaders: request });
    return NextResponse.json({ data: await new QcService().inputOptions(context) });
  } catch (error) {
    return handleRouteError(error);
  }
}

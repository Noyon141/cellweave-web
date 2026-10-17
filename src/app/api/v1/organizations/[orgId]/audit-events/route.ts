import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { AuditService } from "@/server/services/audit-service";
import { handleRouteError } from "@/server/api/error-handler";

interface RouteParams {
  params: Promise<{ orgId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });

    // Parse pagination options safely
    const searchParams = request.nextUrl.searchParams;
    const limit = searchParams.get("limit") ? parseInt(searchParams.get("limit")!, 10) : undefined;
    const offset = searchParams.get("offset")
      ? parseInt(searchParams.get("offset")!, 10)
      : undefined;

    const service = new AuditService();
    const data = await service.listAuditEvents(context, orgId, { limit, offset });

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

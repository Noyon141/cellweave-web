import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import {
  OrganizationService,
  updateOrganizationSettingsSchema,
} from "@/server/services/organization-service";
import { handleRouteError } from "@/server/api/error-handler";
import { extractRequestAuditMetadata } from "@/server/api/request-metadata";

interface RouteParams {
  params: Promise<{ orgId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const service = new OrganizationService();
    const data = await service.getSettings(context, orgId);

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const rawBody = await request.json();
    const validatedBody = updateOrganizationSettingsSchema.parse(rawBody);
    const requestMetadata = extractRequestAuditMetadata(request);

    const service = new OrganizationService();
    const data = await service.updateSettings(context, orgId, validatedBody, {
      requestMetadata,
    });

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

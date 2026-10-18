import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { ProjectService, updateProjectSchema } from "@/server/services/project-service";
import { handleRouteError } from "@/server/api/error-handler";
import { extractRequestAuditMetadata } from "@/server/api/request-metadata";

interface RouteParams {
  params: Promise<{ projectId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { projectId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });

    const service = new ProjectService();
    const data = await service.getProject(context, projectId);

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { projectId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const rawBody = await request.json();
    const validatedBody = updateProjectSchema.parse(rawBody);
    const requestMetadata = extractRequestAuditMetadata(request);

    const service = new ProjectService();
    const data = await service.updateProject(context, projectId, validatedBody, {
      requestMetadata,
    });

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { projectId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const requestMetadata = extractRequestAuditMetadata(request);

    const service = new ProjectService();
    const data = await service.archiveProject(context, projectId, { requestMetadata });

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

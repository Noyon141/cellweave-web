import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { ProjectPermissionService } from "@/server/services/project-permission-service";
import { handleRouteError } from "@/server/api/error-handler";

interface RouteParams {
  params: Promise<{ projectId: string; userId: string }>;
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { projectId, userId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const service = new ProjectPermissionService();
    await service.removeMemberFromProject(context, projectId, userId);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

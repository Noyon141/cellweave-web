import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { ProjectPermissionService } from "@/server/services/project-permission-service";
import { handleRouteError } from "@/server/api/error-handler";
import { extractRequestAuditMetadata } from "@/server/api/request-metadata";
import { z } from "zod";

interface RouteParams {
  params: Promise<{ projectId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { projectId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const service = new ProjectPermissionService();
    const data = await service.listProjectMembers(context, projectId);

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

const assignMemberSchema = z.object({
  userId: z.string().min(1, "Target userId is required"),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { projectId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const rawBody = await request.json();
    const { userId } = assignMemberSchema.parse(rawBody);
    const requestMetadata = extractRequestAuditMetadata(request);

    const service = new ProjectPermissionService();
    const data = await service.assignMemberToProject(context, projectId, userId, {
      requestMetadata,
    });

    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

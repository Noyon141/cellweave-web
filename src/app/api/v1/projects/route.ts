import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { ProjectService, createProjectSchema } from "@/server/services/project-service";
import { handleRouteError } from "@/server/api/error-handler";
import { extractRequestAuditMetadata } from "@/server/api/request-metadata";

export async function GET(request: NextRequest) {
  try {
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const includeArchived = request.nextUrl.searchParams.get("includeArchived") === "true";

    const service = new ProjectService();
    const data = await service.listAccessibleProjects(context, { includeArchived });

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const rawBody = await request.json();
    const validatedBody = createProjectSchema.parse(rawBody);
    const requestMetadata = extractRequestAuditMetadata(request);

    const service = new ProjectService();
    const data = await service.createProject(context, validatedBody, { requestMetadata });

    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

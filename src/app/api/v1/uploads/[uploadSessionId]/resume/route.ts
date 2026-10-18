import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { UploadSessionService } from "@/server/services/upload-session-service";
import { handleRouteError } from "@/server/api/error-handler";

interface RouteParams {
  params: Promise<{ uploadSessionId: string }>;
}

/**
 * GET /api/v1/uploads/[uploadSessionId]/resume
 * Queries authoritative uploaded parts from R2 ListParts and returns resume state.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { uploadSessionId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });

    const service = new UploadSessionService();
    const data = await service.getResumeState(context, uploadSessionId);

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

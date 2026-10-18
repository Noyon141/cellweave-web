import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { UploadSessionService } from "@/server/services/upload-session-service";
import { toSafeUploadSessionDTO } from "@/server/api/upload-session-dto";
import { handleRouteError } from "@/server/api/error-handler";

interface RouteParams {
  params: Promise<{ uploadSessionId: string }>;
}

/**
 * GET /api/v1/uploads/[uploadSessionId]
 * Retrieves upload session status.
 * Returns safe UploadSessionDTO (r2UploadId omitted).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { uploadSessionId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });

    const service = new UploadSessionService();
    const session = await service.getUploadSession(context, uploadSessionId);

    const data = toSafeUploadSessionDTO(session);
    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

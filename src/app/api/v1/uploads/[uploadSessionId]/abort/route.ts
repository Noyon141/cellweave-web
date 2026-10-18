import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { UploadSessionService } from "@/server/services/upload-session-service";
import { toSafeUploadSessionDTO } from "@/server/api/upload-session-dto";
import { handleRouteError } from "@/server/api/error-handler";
import { extractRequestAuditMetadata } from "@/server/api/request-metadata";

interface RouteParams {
  params: Promise<{ uploadSessionId: string }>;
}

/**
 * POST /api/v1/uploads/[uploadSessionId]/abort
 * Aborts a multipart upload session and performs compensating cleanup.
 * Returns safe UploadSessionDTO (r2UploadId omitted).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { uploadSessionId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const requestMetadata = extractRequestAuditMetadata(request);

    const service = new UploadSessionService();
    const session = await service.abortUpload(context, uploadSessionId, { requestMetadata });

    const data = toSafeUploadSessionDTO(session);
    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

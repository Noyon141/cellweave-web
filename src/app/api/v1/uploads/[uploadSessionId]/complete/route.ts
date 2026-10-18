import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { UploadSessionService } from "@/server/services/upload-session-service";
import { toSafeCompleteUploadResultDTO } from "@/server/api/upload-session-dto";
import { handleRouteError } from "@/server/api/error-handler";
import { extractRequestAuditMetadata } from "@/server/api/request-metadata";

interface RouteParams {
  params: Promise<{ uploadSessionId: string }>;
}

/**
 * POST /api/v1/uploads/[uploadSessionId]/complete
 * Completes a multipart upload session and binds verified dataset file.
 * Returns safe CompleteUploadResultDTO (r2UploadId omitted).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { uploadSessionId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const requestMetadata = extractRequestAuditMetadata(request);

    const service = new UploadSessionService();
    const result = await service.completeUpload(context, uploadSessionId, { requestMetadata });

    const data = toSafeCompleteUploadResultDTO(result);
    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

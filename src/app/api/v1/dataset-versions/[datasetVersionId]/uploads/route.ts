import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveTenantContext } from "@/server/authorization";
import { UploadSessionService } from "@/server/services/upload-session-service";
import { toSafeUploadSessionDTO } from "@/server/api/upload-session-dto";
import { handleRouteError } from "@/server/api/error-handler";
import { extractRequestAuditMetadata } from "@/server/api/request-metadata";

interface RouteParams {
  params: Promise<{ datasetVersionId: string }>;
}

const initiateUploadRequestSchema = z.object({
  fileName: z.string().trim().min(1, "fileName is required"),
  expectedSize: z
    .number()
    .int("expectedSize must be an integer")
    .positive("expectedSize must be a positive integer"),
  contentType: z.string().trim().min(1, "contentType is required"),
  partSize: z
    .number()
    .int("partSize must be an integer")
    .positive("partSize must be positive")
    .optional(),
});

/**
 * POST /api/v1/dataset-versions/[datasetVersionId]/uploads
 * Initiates a multipart upload session.
 * Authority injection prevention: datasetVersionId is strictly bound from URL parameter.
 * Returns safe UploadSessionDTO (r2UploadId omitted).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { datasetVersionId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const rawBody = await request.json();
    const validatedBody = initiateUploadRequestSchema.parse(rawBody);
    const requestMetadata = extractRequestAuditMetadata(request);

    const service = new UploadSessionService();
    const session = await service.initiateUpload(
      context,
      {
        datasetVersionId,
        fileName: validatedBody.fileName,
        expectedSize: validatedBody.expectedSize,
        contentType: validatedBody.contentType,
        partSize: validatedBody.partSize,
      },
      { requestMetadata }
    );

    const data = toSafeUploadSessionDTO(session);
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

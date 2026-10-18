import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveTenantContext } from "@/server/authorization";
import { UploadSessionService } from "@/server/services/upload-session-service";
import { handleRouteError } from "@/server/api/error-handler";

interface RouteParams {
  params: Promise<{ uploadSessionId: string }>;
}

const createPartsRequestSchema = z
  .object({
    partNumbers: z
      .array(z.number().int().positive("partNumber must be a positive integer"))
      .min(1, "At least one partNumber is required"),
  })
  .strict();

/**
 * POST /api/v1/uploads/[uploadSessionId]/parts
 * Generates presigned UploadPart URLs for specified part numbers.
 * Cache-Control: no-store, private is strictly enforced.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { uploadSessionId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const rawBody = await request.json();
    const validatedBody = createPartsRequestSchema.parse(rawBody);

    const service = new UploadSessionService();
    const data = await service.createPartUploadUrls(context, {
      sessionId: uploadSessionId,
      partNumbers: validatedBody.partNumbers,
    });

    return NextResponse.json(
      { data },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store, private",
        },
      }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

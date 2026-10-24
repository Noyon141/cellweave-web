import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { ExecutionService, createExecutionSchema } from "@/server/services/execution-service";
import { handleRouteError } from "@/server/api/error-handler";
export async function POST(request: NextRequest) {
  try {
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const input = createExecutionSchema.parse(await request.json());
    return NextResponse.json(
      {
        data: await new ExecutionService().create(
          context,
          input,
          request.headers.get("idempotency-key") ?? ""
        ),
      },
      { status: 202 }
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

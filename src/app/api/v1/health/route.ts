import { NextResponse } from "next/server";
import { getHealthService } from "@/server/application/health-service";

/**
 * API v1 Health Check Route Handler
 * Flow: Thin route handler -> Application Service -> Response mapping
 */
export async function GET() {
  const healthService = getHealthService();
  const status = healthService.getHealthStatus();

  return NextResponse.json(status, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

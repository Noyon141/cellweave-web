import { NextResponse } from "next/server";

/**
 * Polar Webhook Route Handler (Phase 0 Foundation)
 * Flow: Webhook verification boundary -> Application Service -> Response mapping
 * Full webhook processing and reconciliation activates in Phase 11.
 */
export async function POST(request: Request) {
  const signature = request.headers.get("polar-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature header" }, { status: 400 });
  }

  return NextResponse.json({ received: true, phase: "Phase 0 Foundation" }, { status: 200 });
}

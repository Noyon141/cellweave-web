import { NextResponse } from "next/server";

/**
 * BetterAuth Route Handlers (Phase 0 Foundation)
 * Thin integration boundary placeholder.
 * Live auth activation occurs in Phase 1.
 */
export async function GET() {
  return NextResponse.json(
    { status: "placeholder", message: "BetterAuth activates in Phase 1" },
    { status: 200 }
  );
}

export async function POST() {
  return NextResponse.json(
    { status: "placeholder", message: "BetterAuth activates in Phase 1" },
    { status: 200 }
  );
}

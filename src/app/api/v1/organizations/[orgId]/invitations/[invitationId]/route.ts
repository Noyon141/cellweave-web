import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { InvitationService } from "@/server/services/invitation-service";
import { handleRouteError } from "@/server/api/error-handler";

interface InvitationRouteParams {
  params: Promise<{ orgId: string; invitationId: string }>;
}

export async function DELETE(request: NextRequest, { params }: InvitationRouteParams) {
  try {
    const { orgId, invitationId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const service = new InvitationService();
    await service.cancelInvitation(context, orgId, invitationId);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

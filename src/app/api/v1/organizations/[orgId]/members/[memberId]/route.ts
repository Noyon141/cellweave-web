import { NextRequest, NextResponse } from "next/server";
import { resolveTenantContext } from "@/server/authorization";
import { MemberService } from "@/server/services/member-service";
import { handleRouteError } from "@/server/api/error-handler";
import { extractRequestAuditMetadata } from "@/server/api/request-metadata";
import { z } from "zod";

interface MemberRouteParams {
  params: Promise<{ orgId: string; memberId: string }>;
}

const updateRoleSchema = z.object({
  role: z.string().min(1, "Role is required"),
});

export async function PATCH(request: NextRequest, { params }: MemberRouteParams) {
  try {
    const { orgId, memberId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const rawBody = await request.json();
    const { role } = updateRoleSchema.parse(rawBody);
    const requestMetadata = extractRequestAuditMetadata(request);

    const service = new MemberService();
    const data = await service.updateMemberRole(context, orgId, memberId, role, {
      headers: request.headers,
      requestMetadata,
    });

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: MemberRouteParams) {
  try {
    const { orgId, memberId } = await params;
    const context = await resolveTenantContext({ requestOrHeaders: request });
    const requestMetadata = extractRequestAuditMetadata(request);

    const service = new MemberService();
    await service.removeMember(context, orgId, memberId, {
      headers: request.headers,
      requestMetadata,
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}

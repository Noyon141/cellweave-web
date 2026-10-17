import type { NextRequest } from "next/server";

export interface RequestAuditMetadata {
  clientIp: string | null;
  userAgent: string | null;
}

/**
 * Extracts audit metadata from an incoming HTTP request.
 *
 * TRUSTED IP RESOLUTION INVARIANTS:
 * Only platform-level sources are evaluated:
 * 1. request.ip (NextRequest property populated by edge/Vercel runtime)
 * 2. x-real-ip (standard Vercel edge reverse-proxy sanitized header)
 * 3. x-vercel-forwarded-for (first IP in comma-separated list, sanitized by Vercel edge)
 *
 * Client-supplied x-forwarded-for headers are NOT trusted.
 * Raw IP is NEVER persisted — only passed transiently to AuditService for keyed HMAC hashing.
 */
export function extractRequestAuditMetadata(request: Request | NextRequest): RequestAuditMetadata {
  let clientIp: string | null = null;

  if (
    "ip" in request &&
    typeof (request as { ip?: unknown }).ip === "string" &&
    (request as { ip: string }).ip.trim() !== ""
  ) {
    clientIp = (request as { ip: string }).ip.trim();
  }

  const headers = request.headers;

  if (!clientIp) {
    const xRealIp = headers.get("x-real-ip");
    if (xRealIp && xRealIp.trim() !== "") {
      clientIp = xRealIp.trim();
    }
  }

  if (!clientIp) {
    const xVercelForwardedFor = headers.get("x-vercel-forwarded-for");
    if (xVercelForwardedFor && xVercelForwardedFor.trim() !== "") {
      const firstIp = xVercelForwardedFor.split(",")[0]?.trim();
      if (firstIp) {
        clientIp = firstIp;
      }
    }
  }

  const userAgent = headers.get("user-agent")?.trim() || null;

  return {
    clientIp: clientIp || null,
    userAgent: userAgent || null,
  };
}

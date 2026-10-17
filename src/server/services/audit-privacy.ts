import { createHmac } from "node:crypto";
import { env } from "../config/env";
import { ValidationError } from "../authorization";

/**
 * Forbidden keys that suggest sensitive scientific, security, or private data.
 * Master Design / RUO / Privacy Invariant:
 * Never store raw scientific datasets, matrices, gene vectors, PHI, passwords, or tokens in audit logs.
 */
const FORBIDDEN_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /accesstoken/i,
  /refreshtoken/i,
  /idtoken/i,
  /authorization/i,
  /cookie/i,
  /rawdata/i,
  /matrix/i,
  /expression/i,
  /geneexpression/i,
  /patient/i,
  /phi/i,
];

/**
 * Computes a deterministic keyed HMAC hash of a client IP address.
 * Preserves correlation ability while strictly preventing persistence of raw IP addresses.
 */
export function hashIpAddress(
  ip: string | null | undefined,
  secretKey: string = env.AUDIT_IP_HASH_SECRET
): string | null {
  if (!ip || ip.trim() === "") {
    return null;
  }
  return createHmac("sha256", secretKey).update(ip.trim()).digest("hex");
}

/**
 * Validates and sanitizes audit metadata.
 * Fails closed if any forbidden key indicating scientific matrices, PHI, or secrets is present.
 */
export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(metadata)) {
    // Check forbidden key patterns
    for (const pattern of FORBIDDEN_KEY_PATTERNS) {
      if (pattern.test(key)) {
        throw new ValidationError(
          `Forbidden audit metadata key detected: '${key}'. Audit metadata cannot contain secrets, tokens, matrices, or PHI.`
        );
      }
    }

    // Ensure value is JSON-serializable
    if (val === undefined || typeof val === "function" || typeof val === "symbol") {
      continue;
    }

    if (val !== null && typeof val === "object") {
      if (Array.isArray(val)) {
        sanitized[key] = val;
      } else {
        // Recursive sanitization for nested objects
        sanitized[key] = sanitizeAuditMetadata(val as Record<string, unknown>);
      }
    } else {
      sanitized[key] = val;
    }
  }

  return sanitized;
}

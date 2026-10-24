import "server-only";
import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import { z } from "zod";
import { SERVICE_ENVIRONMENTS, SERVICE_SCOPES, type ServiceScope } from "@cellweave/contracts";

export class ServiceAuthenticationError extends Error {
  constructor(
    readonly code:
      "MISSING" | "INVALID" | "SCOPE" | "HEADER" | "SIGNATURE" | "CLAIMS" | "TIME" = "INVALID"
  ) {
    super("Service authentication failed");
    this.name = "ServiceAuthenticationError";
  }
}
export class ServiceVerificationConfigurationError extends Error {
  constructor() {
    super("Invalid service verification configuration");
    this.name = "ServiceVerificationConfigurationError";
  }
}
const configurationSchema = z
  .object({
    environment: z.enum(SERVICE_ENVIRONMENTS),
    algorithm: z.literal("ES256").default("ES256"),
    keys: z
      .array(
        z
          .object({
            kid: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
            publicKeyPem: z.string().startsWith("-----BEGIN PUBLIC KEY-----"),
          })
          .strict()
      )
      .min(1),
  })
  .strict();
const claimsSchema = z
  .object({
    iss: z.string(),
    sub: z.literal("cellweave-orchestrator"),
    aud: z.string(),
    iat: z.number().int().safe(),
    exp: z.number().int().safe(),
    jti: z.string().min(16).max(200),
    scope: z.array(z.enum(SERVICE_SCOPES)).min(1),
  })
  .strict();

/** Imports only configured SPKI public keys; exact kid lookup, no key trial or network. */
export async function createServiceTokenVerifier(configuration: unknown) {
  try {
    const config = configurationSchema.parse(configuration);
    const keys = new Map<string, Awaited<ReturnType<typeof importSPKI>>>();
    for (const entry of config.keys) {
      if (keys.has(entry.kid)) throw new Error();
      const key = await importSPKI(entry.publicKeyPem, "ES256");
      if (
        key.algorithm.name !== "ECDSA" ||
        !("namedCurve" in key.algorithm) ||
        key.algorithm.namedCurve !== "P-256"
      )
        throw new Error();
      keys.set(entry.kid, key);
    }
    return Object.freeze({
      async verify(authorization: string | null, requiredScopes: readonly ServiceScope[]) {
        if (!authorization) throw new ServiceAuthenticationError("MISSING");
        let stage: "HEADER" | "SIGNATURE" | "CLAIMS" | "TIME" = "HEADER";
        try {
          if (
            !/^Bearer [^ ]+$/.test(authorization) ||
            !requiredScopes.length ||
            requiredScopes.some((s) => !SERVICE_SCOPES.includes(s))
          )
            throw new Error();
          const token = authorization.slice(7);
          const header = decodeProtectedHeader(token);
          if (header.alg !== "ES256" || header.typ !== "JWT" || typeof header.kid !== "string")
            throw new Error();
          const key = keys.get(header.kid);
          if (!key) throw new Error();
          stage = "SIGNATURE";
          const result = await jwtVerify(token, key, {
            algorithms: ["ES256"],
            issuer: `cellweave-orchestrator:${config.environment}`,
            audience: `cellweave-web-internal:${config.environment}`,
            clockTolerance: 30,
            requiredClaims: ["iss", "sub", "aud", "iat", "exp", "jti", "scope"],
          });
          stage = "CLAIMS";
          const claims = claimsSchema.parse(result.payload);
          stage = "TIME";
          const now = Math.floor(Date.now() / 1000);
          if (
            claims.exp <= claims.iat ||
            claims.exp - claims.iat > 900 ||
            claims.iat > now + 30 ||
            new Set(claims.scope).size !== claims.scope.length
          )
            throw new Error();
          if (requiredScopes.some((scope) => !claims.scope.includes(scope)))
            throw new ServiceAuthenticationError("SCOPE");
          return Object.freeze({
            issuer: claims.iss,
            subject: claims.sub,
            audience: claims.aud,
            kid: header.kid,
            jti: claims.jti,
            scopes: Object.freeze(claims.scope),
          });
        } catch (error) {
          if (error instanceof ServiceAuthenticationError) throw error;
          throw new ServiceAuthenticationError(stage);
        }
      },
    });
  } catch {
    throw new ServiceVerificationConfigurationError();
  }
}

let verifier: ReturnType<typeof createServiceTokenVerifier> | undefined;
export function getServiceTokenVerifier() {
  if (!verifier) {
    try {
      if (
        !process.env.CELLWEAVE_ENVIRONMENT ||
        process.env.CELLWEAVE_ENVIRONMENT !== process.env.SERVICE_AUTH_ENVIRONMENT
      )
        throw new ServiceVerificationConfigurationError();
      verifier = createServiceTokenVerifier({
        environment: process.env.SERVICE_AUTH_ENVIRONMENT,
        algorithm: process.env.SERVICE_AUTH_ALGORITHM ?? "ES256",
        keys: JSON.parse(process.env.SERVICE_AUTH_TRUST_BUNDLE ?? "null"),
      }).catch((error) => {
        verifier = undefined;
        throw error;
      });
    } catch {
      throw new ServiceVerificationConfigurationError();
    }
  }
  return verifier;
}

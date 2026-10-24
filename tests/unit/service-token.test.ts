import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import { createServiceTokenVerifier } from "@/server/authorization/service-token";

let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let previous: Awaited<ReturnType<typeof generateKeyPair>>;
let verify: Awaited<ReturnType<typeof createServiceTokenVerifier>>;
const now = () => Math.floor(Date.now() / 1000);
async function token(
  overrides: Record<string, unknown> = {},
  kid = "current",
  signingKey = pair.privateKey
) {
  return new SignJWT({
    iss: "cellweave-orchestrator:development",
    sub: "cellweave-orchestrator",
    aud: "cellweave-web-internal:development",
    iat: now(),
    exp: now() + 300,
    jti: "correlation-test-unique-token",
    scope: ["execution.project"],
    ...overrides,
  })
    .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
    .sign(signingKey);
}
beforeAll(async () => {
  pair = await generateKeyPair("ES256");
  previous = await generateKeyPair("ES256");
  verify = await createServiceTokenVerifier({
    environment: "development",
    keys: [
      { kid: "current", publicKeyPem: await exportSPKI(pair.publicKey) },
      { kid: "previous", publicKeyPem: await exportSPKI(previous.publicKey) },
    ],
  });
});
describe("service JWT trust boundary", () => {
  it("accepts valid current and overlapping previous keys", async () => {
    for (const [kid, key] of [
      ["current", pair.privateKey],
      ["previous", previous.privateKey],
    ] as const) {
      const result = await verify.verify(`Bearer ${await token({}, kid, key)}`, [
        "execution.project",
      ]);
      expect(result.subject).toBe("cellweave-orchestrator");
      expect(result.kid).toBe(kid);
      expect(result).not.toHaveProperty("organizationId");
    }
  });
  it.each([
    { exp: 1 },
    { iss: "attacker" },
    { aud: "another-service" },
    { sub: "cellweave-web" },
    { scope: [] },
    { scope: ["execution.finalize"] },
    { scope: ["admin"] },
    { exp: now() + 901 },
    { iat: now() + 120, exp: now() + 420 },
    { jti: "" },
    { organizationId: "foreign-tenant" },
  ])("rejects invalid or excessive claims %j", async (overrides) => {
    await expect(
      verify.verify(`Bearer ${await token(overrides)}`, ["execution.project"])
    ).rejects.toThrow("Service authentication failed");
  });
  it.each(["iss", "sub", "aud", "iat", "exp", "jti", "scope"])("requires %s", async (claim) => {
    await expect(
      verify.verify(`Bearer ${await token({ [claim]: undefined })}`, ["execution.project"])
    ).rejects.toThrow();
  });
  it.each(["unknown", "retired"])("rejects %s key without trying other keys", async (kid) => {
    await expect(
      verify.verify(`Bearer ${await token({}, kid)}`, ["execution.project"])
    ).rejects.toThrow();
  });
  it("rejects tampered signature", async () => {
    const parts = (await token()).split(".");
    const signature = parts[2]!;
    parts[2] = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    await expect(
      verify.verify(`Bearer ${parts.join(".")}`, ["execution.project"])
    ).rejects.toThrow();
  });
  it("rejects HS256 and missing credentials", async () => {
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: "current" })
      .sign(new Uint8Array(32));
    await expect(verify.verify(`Bearer ${jwt}`, ["execution.project"])).rejects.toThrow();
    await expect(verify.verify(null, ["execution.project"])).rejects.toThrow();
  });
  it("rejects DEV token even if STAGING accidentally trusts the same public key", async () => {
    const staging = await createServiceTokenVerifier({
      environment: "staging",
      keys: [{ kid: "current", publicKeyPem: await exportSPKI(pair.publicKey) }],
    });
    await expect(
      staging.verify(`Bearer ${await token()}`, ["execution.project"])
    ).rejects.toThrow();
  });
  it.each([
    {},
    { environment: "development", keys: [] },
    { environment: "development", algorithm: "HS256", keys: [] },
  ])("fails closed on incomplete config", async (config) => {
    await expect(createServiceTokenVerifier(config)).rejects.toThrow(
      "Invalid service verification configuration"
    );
  });
  it("rejects duplicate kid and malformed/public-key substitution", async () => {
    const entry = { kid: "same", publicKeyPem: await exportSPKI(pair.publicKey) };
    await expect(
      createServiceTokenVerifier({ environment: "development", keys: [entry, entry] })
    ).rejects.toThrow();
    await expect(
      createServiceTokenVerifier({
        environment: "development",
        keys: [{ kid: "current", publicKeyPem: "invalid" }],
      })
    ).rejects.toThrow();
  });
});

# Approved Phase 4 internal service authentication

Status: accepted by explicit project instruction. This ADR records that decision;
it does not change the master blueprint.

Use jose 6.2.12, JWT ES256 only, P-256. Default TTL 300 seconds; hard maximum
900 seconds; verification clock tolerance 30 seconds. Required claims: iss, sub,
aud, iat, exp, jti, scope. No algorithm negotiation or shared-master-token model.

Orchestrator subject is `cellweave-orchestrator`. Issuer is
`cellweave-orchestrator:{environment}`; audience is
`cellweave-web-internal:{environment}`. Environments are local, development,
staging, production. Deployments MUST use distinct keypairs per environment.
These environment-qualified identities also reject a lower-environment token
if an operator accidentally duplicates a trusted public key.

Issuer configuration: SERVICE_AUTH_ENVIRONMENT, SERVICE_AUTH_ACTIVE_KID,
SERVICE_AUTH_PRIVATE_KEY_PEM (PKCS#8), optional SERVICE_AUTH_TTL_SECONDS (300).
SERVICE_AUTH_ALGORITHM, if specified, must be ES256.
Verifier configuration: SERVICE_AUTH_ENVIRONMENT, SERVICE_AUTH_TRUST_BUNDLE:
a JSON array of objects containing exactly kid and publicKeyPem (SPKI).
Private keys belong only to the issuer. Missing/malformed configuration fails
closed; no production keys are generated and no signing material is logged.

Shared scope vocabulary is generated from canonical internal JSON Schema:
execution.prepare, execution.project, execution.finalize, execution.cancel,
capability.issue. Operations require their specific scopes. Service identity
NEVER substitutes for persisted tenant/run/project/dataset authorization.

Rotation: install new kid/public key in verifier trust; deploy; switch active
issuer kid/private key; wait beyond maximum lifetime plus clock tolerance;
remove the retired public key. Exact kid lookup only. No network JWKS service.
JTI is cryptographically unique correlation metadata, not a global replay cache.
Activity retries remain permitted; business operations enforce idempotency.

Never reuse customer, Temporal, database, storage, or Polar credentials.
Science receives scoped capabilities, not reusable service tokens. Temporal
continues using native TLS/auth. Deployment secrets stay out of Git and logs.

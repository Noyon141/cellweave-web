---
trigger: model_decision
description: "Use for API routes, Server Actions, integration payloads, idempotent writes, or public/internal API evolution."
---

# API and Contract Rules

Durable domain API prefix: `/api/v1/*`.

Route Handler sequence:
1. authenticate
2. validate
3. authorize
4. call application service
5. map response

Route files contain no scientific/business workflow.

Server Actions call the same application layer.

Use `cellweave-contracts` generated artifacts for cross-language/service payloads.

Compatibility:
- breaking public API changes require `/v2`
- internal contracts carry explicit schema versions
- scientific job payloads include `schemaVersion` and `pipelineVersion`

Idempotency is required for:
- upload completion
- run creation
- workflow startup
- Polar webhook handling
- billing events
- notifications
- artifact registration

Client writes may accept `Idempotency-Key`.

Do not create duplicate business effects from retries.

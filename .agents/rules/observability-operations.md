---
trigger: model_decision
description: "Use for logs, metrics, traces, operations console, support diagnostics, error classification, feature flags, or incidents."
---

# Observability and Operations

Three pillars:
logs, metrics, traces.

Use:
- OpenTelemetry
- Sentry
- structured logs
- provider metrics

Correlate where security-appropriate:
requestId, organizationId, analysisRunId, workflowId.

Never log scientific matrices.

Distinguish:
- PLATFORM_ERROR
- SCIENTIFIC_VALIDATION_ERROR

Support uses correlation IDs and can trace request → run → Temporal workflow → Modal job → audit history without raw scientific access by default.

Operations metrics include:
queued/running/failed analyses, CPU/GPU, compute cost, Polar revenue, gross compute margin, R2 storage, Neon load, Temporal failures, webhook failures.

Feature flags are scoped by environment/org/user.
Scientific rollouts begin with internal/test tenants.

Do not invent a feature-flag or central-log vendor if none is already selected.

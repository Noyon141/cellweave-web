---
trigger: model_decision
description: "Use when adding tests, changing CI, migrations, release checks, security gates, or production qualification."
---

# Web Testing and Release Rules

PR pipeline:
install → lint → format → TypeScript typecheck → unit tests → authorization tests → DB migration validation → build → Playwright smoke → preview.

Production:
migration safety gate → deploy → health check → synthetic smoke → progressive feature activation.

Mandatory security behavior:
- cross-tenant tests for every protected resource
- webhook replay/idempotency tests where relevant
- upload interruption/resume test
- deletion tenant-safety test
- quota and billing duplicate-event tests where relevant

Performance:
- concurrent dashboard users
- simultaneous upload initialization
- multiple active uploads
- hundreds of status requests
- workflow submission bursts
- compute-completion bursts
- Polar webhook bursts

No UI request waits synchronously on scientific compute.

Documentation updates are part of Definition of Done.

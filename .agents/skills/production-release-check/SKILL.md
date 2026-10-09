---
name: production-release-check
description: Checks a CellWeave web release against CI, migration, tenant, upload, billing, observability, performance, deletion, and production Definition of Done gates.
---

# Production Release Check

Verify applicable gates:
- lint/format/typecheck/unit tests
- authorization/cross-tenant tests
- migration validation/safety
- build
- Playwright smoke
- health/synthetic smoke
- progressive activation
- upload resume/interruption
- deletion workflow tenant safety
- billing duplicate/reconciliation
- quota enforcement
- audit logging
- support correlation ids
- secure headers/rate limits
- observability
- docs updated
- no synchronous scientific pipeline waiting
- no Vercel large-file proxying
- no provenance mutation

Do not declare CellWeave production-ready from a successful deploy alone.

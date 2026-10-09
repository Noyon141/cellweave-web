---
name: implement-web-feature
description: Implements a CellWeave web/business feature without crossing architecture, tenancy, scientific, billing, or performance boundaries.
---

# Implement Web Feature

1. Locate the exact requirement in the authoritative design and identify its implementation phase.
2. Verify the feature belongs in `cellweave-web`.
3. Identify affected domain/application/infrastructure/UI layers before editing.
4. Identify tenant ownership and required `TenantContext`.
5. Identify generated contracts and reuse them.
6. For writes, determine idempotency and audit-event requirements.
7. Keep Route Handlers/Server Actions thin.
8. Keep scientific compute out of the web process.
9. Add domain-aware errors and correlation behavior.
10. Add authorization and cross-tenant tests where protected data is touched.
11. Add unit/integration/UI tests appropriate to the feature.
12. Run repository-defined lint/type/test/build checks.
13. Update system documentation required by Definition of Done.
14. Final review: no new scope, no provider lock-in, no PHI/clinical behavior, no unapproved architecture decision.

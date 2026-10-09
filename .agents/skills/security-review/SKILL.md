---
name: security-review
description: Reviews a CellWeave web change against tenant isolation, access control, object security, secrets, PHI prohibition, break-glass, webhooks, and threat-model requirements.
---

# Security Review

Check:
1. Every tenant-owned object resolves to organization and project authorization.
2. Browser-supplied tenant ids are never trusted.
3. Cross-tenant tests exist.
4. R2 objects are private; signed URLs are short-lived.
5. Secrets are absent from Git/browser/logs/artifacts/manifests.
6. CSRF/cookie/session/security-header requirements remain intact.
7. Webhooks are verified and replay-safe.
8. Writes are idempotent where required.
9. Staff paths use separate authorization.
10. Break-glass is reasoned, expiring, audited.
11. Raw scientific data is absent from audit/product analytics.
12. PHI/clinical/diagnostic scope is not introduced.
13. Rate/compute-abuse protections are preserved.
14. Dependency/secret scanning implications are addressed.
15. Any suspected cross-tenant exposure is treated as SEV-1.

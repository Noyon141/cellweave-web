---
trigger: model_decision
description: "Use for authentication, authorization, tenant-owned data, project access, roles, staff access, or security-sensitive endpoints."
---

# Authentication, Authorization, Tenancy, Staff Access

V1 authentication:
- email/password
- Google OAuth
- BetterAuth organizations

Enterprise OIDC/SAML is future-ready, not a V1 feature by default.

Authorization levels:
1. organization role baseline
2. project-specific permissions

Every tenant-owned domain table/object resolves to `organizationId`.

Never trust:
- `organizationId` from browser
- project/resource access based solely on resource id
- role claims without server-side membership validation

Repository methods accept `TenantContext`, not arbitrary tenant IDs.

Tests:
- every protected resource type gets cross-tenant denial tests
- project permission boundaries are tested separately from org role

RLS:
- production domain tables should additionally use Postgres RLS where practical
- application authorization remains mandatory
- background service credentials use separate explicit privileges

Operations console:
- `/(ops)` has completely separate staff authorization
- customer roles do not imply staff access
- staff do not inspect scientific data by default
- break-glass requires privileged role, explicit reason, short expiry, audit event
- no silent customer impersonation

Security baseline:
TLS, encryption at rest, private storage, short-lived URLs, least privilege, rate limiting, secure headers, CSRF where relevant, SameSite secure cookies, session rotation, webhook verification, idempotency, audit logging.

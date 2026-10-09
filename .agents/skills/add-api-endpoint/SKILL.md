---
name: add-api-endpoint
description: Adds or changes a CellWeave `/api/v1` or internal endpoint using the mandatory authentication-validation-authorization-application-service flow.
---

# Add API Endpoint

1. Confirm endpoint is required by the design and determine `/api/v1`, `/api/internal`, auth, or webhook ownership.
2. Reuse or update `cellweave-contracts`; do not create duplicate cross-service payload types.
3. Implement request validation.
4. Authenticate.
5. Derive and validate tenant membership server-side.
6. Authorize organization + project access.
7. Call an application service; do not place workflow/business logic in the route.
8. Map domain errors to stable domain-aware responses.
9. Apply idempotency for applicable writes.
10. Record audit events for security/business mutations required by design.
11. Add happy-path, validation, permission, and cross-tenant tests.
12. Verify compatibility rules; breaking public API changes require versioning.

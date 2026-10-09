---
name: change-database-domain
description: Changes CellWeave Drizzle schema or domain persistence while preserving tenant isolation, immutability, safe migrations, auditability, and operational/scientific data separation.
---

# Change Database / Domain

1. Confirm the entity/field is authorized by the system design.
2. Confirm whether BetterAuth already owns the concept.
3. Put `organizationId` on tenant-owned tables.
4. Use server-generated sortable external ids such as UUIDv7.
5. Preserve immutable/versioned resources and append-only histories.
6. Design repository access around `TenantContext`.
7. Add indexes specified by design and workload needs already justified by design.
8. Use expand → backfill → switch → contract migration sequence.
9. Avoid long locks, immediate destructive drops, or large synchronous rewrites.
10. Add cross-tenant repository/integration tests.
11. Add/update RLS defense-in-depth where practical.
12. Never store heavy scientific matrices in Postgres.
13. Verify deletion cascade cannot cross tenants.

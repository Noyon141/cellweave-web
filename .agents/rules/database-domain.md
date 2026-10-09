---
trigger: model_decision
description: "Use for Drizzle schema, repositories, migrations, domain entities, immutability, audit events, or data lifecycle."
---

# Database / Domain Rules

Technology:
- PostgreSQL / Neon
- Drizzle ORM

Postgres stores metadata and operational state, not large scientific matrices.

Core domain schema is defined by the system design. Do not remove or merge required concepts merely for convenience.

Identifiers:
- use sortable server-generated identifiers such as UUIDv7
- never expose sequential integer ids externally

Immutability:
- dataset versions are immutable once used by analysis
- comparison versions are immutable analytical objects
- pipeline versions are immutable after production use
- audit events are append-only at application level
- annotation changes retain revision history
- run provenance remains immutable

BetterAuth owns auth/session/org-related records where appropriate; do not duplicate without domain reason.

Migrations use:
expand → migrate/backfill → switch application → contract.

Avoid:
- large synchronous table rewrites
- dropping still-used columns
- long locks on large production tables

Backward compatibility must exist during deployment windows.

Deletion lifecycle:
ACTIVE → SOFT_DELETED → RECOVERY_WINDOW → PURGE_PENDING → PURGED.

Tenant-safe cascades are mandatory.

Audit metadata never contains raw scientific datasets.

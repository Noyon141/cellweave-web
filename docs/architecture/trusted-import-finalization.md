# Phase 3 Step I — Trusted Import Finalization

This internal web service consumes an already verified H.2
`CanonicalArtifactPublicationResult`. It has no route, browser-callable Server
Action, R2 access, presigning, publication transport, file inspection, or scientific
inference. Trusted orchestration integration is deferred; Phase 4 is not implemented.

## Credentials and lifecycle

Ordinary services retain `DATABASE_URL → createDbClient() → getDb()`, authenticated
as `cellweave_app_runtime`.

`IMPORT_FINALIZER_DATABASE_URL` is a separate server environment variable for
`cellweave_import_finalizer`. It is optional for ordinary application startup but
required when initializing finalization. Never put it in `NEXT_PUBLIC_*`, client
props, logs, manifests, or source control. It must not use the runtime, legacy, or
owner role. `.env.example` contains an empty slot only.

`getImportFinalizerDb()` uses an isolated lazy singleton Promise. Concurrent callers
share one pool initialization. It validates the URL role and verifies
`SELECT current_user` once before making the client available. Missing, blank,
malformed, or wrong-role configuration fails explicitly. Role mismatch and
connection failure close the rejected pool; later calls can retry initialization.
No path calls `getDb()`, defaults to `DATABASE_URL`, or passes undefined to the
ordinary factory. Both privileged modules import Next's `server-only` marker;
Vitest resolves its server implementation through Next's bundled empty module.

## Internal input authority

`finalizePublishedDatasetImport()` accepts a server-validated `TenantContext`,
dataset version ID, generated publication result, trusted scientific facts, and
optional trusted request audit metadata. It does not establish a session or
membership itself. Only trusted server code may call it after resolving tenant
authorization; TypeScript types alone do not establish trust.

Before resolving the privileged connection it validates:

- Publication status is exactly `PUBLISHED` or `ALREADY_PRESENT`.
- Publication dataset version ID exactly matches the requested ID.
- The sole canonical checksum is the publication result's exact 64-character
  lowercase hexadecimal SHA-256. Invalid input is never normalized.
- Publication byte size is a non-negative safe integer. It is validated but not
  persisted or sent to SQL, which has no byte-size parameter.
- Scientific cell/gene counts are positive integers within PostgreSQL `integer`
  range. Organism and gene ID scheme are nonblank trusted facts.
- Reference build is the exact trusted string or null, without inference.

The input rejects extra authority fields. Organization and user actor IDs come
only from `TenantContext`. Actor type is `user`, following the existing tenant
audit convention. Optional audit metadata must already have passed the existing
trusted request extraction boundary; IP is HMAC-pseudonymized with
`hashIpAddress()`, and user agent is trimmed. Raw browser actor/tenant overrides
are not accepted. There is no independent source checksum, manifest ID, source
format, file/session list, or canonical key input.

## Existing atomic database boundary

The service makes exactly one parameterized call to the existing migration 0004
function, with no application-side updates or audit inserts:

```text
public.finalize_dataset_version_import(
  p_organization_id text,
  p_dataset_version_id text,
  p_canonical_checksum text,
  p_organism text,
  p_gene_id_scheme text,
  p_reference_build text,
  p_cell_count integer,
  p_gene_count integer,
  p_actor_type text,
  p_actor_id text,
  p_ip_hash text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_audit_event_id text DEFAULT NULL
)
RETURNS TABLE (
  status text,
  canonical_artifact_key text,
  finalized_at timestamptz
)
```

Migration 0004 declares `SECURITY DEFINER`, `search_path = public, pg_temp`, and
conditional ownership transfer to `neondb_owner` when that role exists. It revokes
PUBLIC/runtime EXECUTE and grants finalizer EXECUTE. It does not grant finalizer
direct UPDATE on dataset versions or upload sessions. Actual owner, schema
privileges, inherited permissions, and function ACLs require live qualification;
the role assertion alone does not establish effective privilege correctness.

PostgreSQL derives source/import facts and canonical object key from tenant-bound
persisted state. It owns locking, manifest/provenance validation, scientific fact
finalization, participating sessions' `VERIFIED → IMPORTED` transition, and the
single `dataset.imported` audit insert atomically.

`FINALIZED` and `ALREADY_FINALIZED` are successful internal results. `ALREADY_PRESENT`
publication is equally eligible. Each application invocation generates a new
`aud_` UUIDv7 candidate through the existing ID utility; SQL replay returns before
the audit insertion, so candidate freshness does not change idempotency. No retry
or second function call occurs inside the service.

The result contains dataset version ID, canonical checksum, status, and the
database-returned timestamp. The returned canonical key is validated but omitted
from the result and never becomes caller authority. Existing SQL returns version
`created_at` as `finalized_at` on replay; Step I preserves that behavior rather
than claiming the replay timestamp is the first finalization time.

Checksum/scientific-fact conflicts, concurrent finalization conflicts, upload state
conflicts, and source-format mismatches become a typed internal conflict. Tenant
misses produce a non-disclosing security error. Other failures and malformed DB
results produce controlled internal errors. Raw PostgreSQL errors, SQL text,
credentials, resource details, and original causes are never propagated or logged.

## Qualification and deferred work

Unit tests verify separate connections, failure closure, singleton initialization,
role checks, validation before connection creation, SQL parameter authority,
replay, conflict/error redaction, UUIDv7 candidates, and import boundaries.

If a dedicated DEV credential is available, qualification must first verify
`current_user`, effective function EXECUTE, absence of inappropriate direct UPDATE,
and runtime denial. Disposable DB fixtures may then qualify first finalization,
replay, conflicts, session transitions, and exactly-once audit persistence. This
is DB finalizer qualification, not end-to-end import qualification; live H.2 R2
publication has not been qualified here. Never run this against STAGING or PROD.

Step I implementation audit: LIVE DEV FINALIZER QUALIFICATION NOT RUN — dedicated
finalizer credential unavailable. No live role, ACL, session transition, or audit
count result is claimed.

Historical `apply-staging-grants.mjs`, `verify-staging-db.mjs`, and migration 0000
retain legacy role references. The scripts have no repository workflow invocation
and must not be reused as current provisioning. Record this technical debt for
the Phase 3 final exit audit; Step I does not alter historical provisioning or
applied migrations.

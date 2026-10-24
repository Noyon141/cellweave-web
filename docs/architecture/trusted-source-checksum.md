# Phase 3 trusted source checksums

`DatasetImportService.submitImportManifest()` creates the import root and exact
file membership using persisted source authority. `createTrustedImportManifest()`
is a compatibility name for the same path; neither accepts `sourceChecksum`.
The public dataset-version creation schema also rejects caller source checksums
and initializes `dataset_versions.source_checksum` to null.

## Authoritative facts

| Fact                             | Owner                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Exact persisted safe filename    | `dataset_files.file_name`                                                                            |
| Exact physical byte size         | `dataset_files.byte_size`, established at verified upload completion                                 |
| Trusted physical SHA-256         | `dataset_file_provenance.sha256`                                                                     |
| File identity / tenant / version | `dataset_files.id`, `organization_id`, `dataset_version_id`                                          |
| Physical upload-session binding  | `dataset_file_provenance.upload_session_id`, reinforced by tenant/version/key composite foreign keys |
| Source format                    | Tenant-scoped `dataset_versions.source_format`, validated against the four supported formats         |
| Candidate membership             | Validated file IDs, roles, and ordinals; persisted atomically in `dataset_import_files`              |

The provider does not reconstruct filenames from keys or request paths, HEAD R2,
consume ETags, accept caller file facts, or read/download source bytes.

## Format-specific algorithm

One pure helper, `computeTrustedSourceChecksum()`, matches the approved science
`compute_source_checksum()` policy:

| Validated source format | Checksum                                                                     |
| ----------------------- | ---------------------------------------------------------------------------- |
| `H5AD`                  | Exact trusted SHA-256 of the single `PRIMARY` source file                    |
| `TENX_H5`               | Exact trusted SHA-256 of the single `PRIMARY` source file                    |
| `TENX_MTX`              | SHA-256 of the complete deterministic source manifest                        |
| `GENERIC_MATRIX`        | SHA-256 of the complete deterministic source manifest, **even for one file** |

Each manifest row is exactly:

```text
{persistedSafeFileName}\t{byteSize}\t{sha256}\n
```

Separators are ASCII TAB, endings are LF, encoding is UTF-8, and sizes are
non-negative safe base-10 integers. Rows sort by exact case-sensitive UTF-8 byte
order, equivalent to Python Unicode code-point order for valid Unicode. This
also handles supplementary Unicode correctly, without locale sorting. Filenames
retain case and spelling; existing persisted-safe filename rules are checked
without using normalized replacements. Malformed Unicode, unsafe filenames,
duplicate filenames/file IDs, invalid cardinality, unsafe sizes, and non-exact
lowercase 64-hex SHA values fail closed. Roles, ordinals, IDs, storage keys,
tenant/project IDs, and ETags never enter serialized bytes.

## Production wiring and consistency boundary

Production construction always installs `PersistedSourceChecksumProvider`. The
only override is explicitly named `testDependencies` for isolated tests. No
browser endpoint selects a provider. All import submission fields are validated
and snapshotted before awaits; unsupported fields cannot override authority.

Ordinary reads use `getDb()` / `cellweave_app_runtime`. Import/provenance writes
use `getImportFinalizerDb()` / `cellweave_import_finalizer`; no broad source-table
privileges or ordinary-runtime import writes are added. The latter connection
retains Step I's separate configuration and fail-closed role assertion.

Inside the import-write transaction, the service validates the tenant-owned
persisted format and obtains all selected facts in one joined SELECT statement.
The SELECT explicitly filters selected file IDs, tenant, version, and verified
upload status. Composite joins include tenant, version, and physical R2 key.
Resolved membership must match exactly: missing, duplicate, extra, foreign-tenant,
foreign-version, or mismatched-format rows fail before root insertion.

The read and write clients are separate connections; this is **not** a distributed
transaction. TOCTOU safety relies on the already locked append-only source-fact
policy: ordinary runtime has SELECT/INSERT only on `dataset_files`; runtime cannot
mutate provenance, and finalizer has SELECT/INSERT only on provenance/import
tables. Neither application role can UPDATE/DELETE the checksum facts. Version
source format is immutable under the approved runtime policy. Therefore source
facts selected in the statement snapshot cannot change through these application
roles before persistence. Foreign keys reject file/version deletion races; root
and exact membership commit or roll back together. Upload state may be rechecked
by the SQL finalizer and is never serialized into the source checksum.

Owner/administrative rewriting of immutable source facts violates this boundary
and is not made safe by application tests. Effective deployed grants and inherited
privileges still require live qualification; no live database correctness is
claimed here. No new privileges, schema migration, or broad locking redesign is
introduced.

## Finalizer and evidence

Existing migration 0004 derives `dataset_imports.source_checksum` and copies it
to `dataset_versions.source_checksum` atomically during trusted finalization.
Step I takes no application source-checksum argument and is unchanged.

Tests cover real provider wiring with a simulated database, exact membership and
SQL scoping, atomic rollback, authority rejection, and fixed Python-generated
vectors. The TENX_MTX vector matches science's existing three-file fixture.
These are metadata aggregation tests, not live R2/DB qualification.

The old `DatasetImportService.finalizeImport()` has no production caller or route;
it remains untouched technical debt and is not used by this correction. Live H.2
R2 and Step I finalizer qualification remain NOT RUN. No other repository or
dependency is changed, and Phase 4 is not implemented.

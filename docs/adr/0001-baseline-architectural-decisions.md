# ADR 0001: Baseline Architectural Decisions

## Status
Accepted (Mandatory Baseline)

## Context
The CellWeave system architecture establishes core boundaries and baseline platform technologies across five distinct repositories (`cellweave-web`, `cellweave-orchestrator`, `cellweave-science`, `cellweave-contracts`, `cellweave-infra`). To prevent boundary erosion and architectural drift, baseline decisions must be recorded and defended.

## Baseline Decisions

1. **ADR-001 AnnData Canonical Representation**: All supported single-cell input formats (`.h5ad`, 10x filtered matrices, CSV/TSV matrices + metadata) convert to canonical AnnData (`canonical.h5ad`). Downstream pipelines execute exclusively against this representation.
2. **ADR-002 Cloudflare R2 Object Storage**: R2 provides private, multi-tenant partitioned storage for scientific datasets and analysis artifacts. No direct public bucket access; downloads use short-lived signed URLs.
3. **ADR-003 Temporal Durable Workflows**: Temporal Cloud orchestrates long-running execution, activities, retries, and human-in-the-loop signals. Temporal is the authority for execution state; Postgres is the authority for business entities and projections.
4. **ADR-004 Modal Initial Compute Provider**: Initial compute execution runs on Modal under a strictly abstracted `ComputeProvider` interface. No business logic directly couples to Modal APIs.
5. **ADR-005 Polar Billing Integration**: Polar provides commercial billing, subscription management, and customer portal. Internal immutable usage ledgers remain the source of truth for usage and reconciliation.
6. **ADR-006 Processed-Data-Only**: Scope for V1 is restricted to downstream analysis from processed single-cell RNA-seq inputs (no raw FASTQ processing).
7. **ADR-007 Pseudobulk Condition Differential Expression**: Condition comparisons default toward sample-level/pseudobulk when biological replicates exist. Single cells are never treated as independent biological replicates.
8. **ADR-008 No Protected Health Information (PHI)**: CellWeave V1 is strictly Research Use Only (RUO), non-diagnostic, and prohibits PHI.
9. **ADR-009 Separate Repositories**: Five independent repositories maintain strict separation of concerns across web, orchestration, science, contracts, and infrastructure.

## Consequences
Any alteration to these baseline decisions requires formal architectural review and update to the authoritative master system design.

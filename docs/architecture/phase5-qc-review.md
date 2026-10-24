# Phase 5 QC review and immutable filtering

Phase 5 computes QC and waits for an authorized human decision. It does not run normalization, HVG, PCA, neighbors, UMAP, clustering, annotation, markers or differential expression.

## Scientific policy

The immutable canonical input remains raw cells-by-genes CSR counts. Metrics are total_counts, n_genes_by_counts, total_counts_mt, pct_counts_mt, total_counts_ribo and pct_counts_ribo. Explicit gene_symbol metadata is required for mitochondrial/ribosomal identification: human MT-/RPS/RPL and mouse mt-/Rps/Rpl. No Ensembl lookup or case conversion is performed. Missing symbols produce unavailable gene-set metrics and a typed issue. Zero-count cells remain present; percentages are null rather than misleading zero values.

Registered sample_key values are authoritative. An explicit whole-input registered sample binding is supported for otherwise unmapped inputs; there is no barcode inference. Summaries are global and per sample. Capture/library grouping is explicit and independent of biological sample. Unresolved captures and insufficient/degenerate groups are NOT_ASSESSED with null scores/flags, never falsely non-doublet.

Doublets use Scanpy 1.10.1 bundled Scrublet, profile cellweave-scanpy-scrublet-v1: sim_doublet_ratio=2, expected_doublet_rate=0.05, stdev_doublet_rate=0.02, synthetic_doublet_umi_subsampling=1, n_prin_comps=30, automatic threshold, seed=42. The full effective settings, software versions, grouping, inferred threshold and outcome are recorded. Scrublet operates on an isolated copy; internal transformations never replace canonical/raw counts. No cells are automatically deleted. No numeric suggested cutoffs are emitted without validated scientific evidence.

## Trusted preview and decision

Browser input is decision intent only. A trusted science PREVIEW computes a candidate selection and exact included/excluded counts. The bounded browser response contains proof and summaries, not cell arrays. The compressed selection artifact contains an exact ordered cell mask. Thresholds are inclusive; per-sample bounds replace global bounds for the same metric. Unavailable metrics, unassessed-doublet exclusion and empty retained selections fail closed.

Selection parameters use qc-selection-f64-v1: recursively sorted object keys, original array order, UTF-8 JSON strings, and numbers encoded as n followed by the IEEE754 binary64 big-endian hex. Python and TypeScript share fixed digest vectors. This binds thresholds exactly without cross-language float rendering ambiguity.

The server resolves TenantContext, project permission, current persisted actor membership, run, canonical checksum, QC revision and current preview. Approval accepts only previewId and reason. It persists one immutable QC Decision and durable approval_pending intent in one transaction, then signals Temporal. Repeated identical approval is idempotent; stale previews, conflicting decisions and canceled runs reject. A valid service JWT never replaces tenant/resource checks.

## Durable execution and artifacts

phase5QcWorkflow uses analysis-run:{id}. Signals only wake it; an Activity resolves the persisted decision. Review waits indefinitely in Temporal history with no running scientific compute or open customer HTTP request. Pending signal delivery and failed projections reconcile after restart. The worker does not repeatedly signal a healthy idle review. Each QC/PREVIEW/FILTER submission has a stable logical identity and preallocated artifact IDs. Fresh scoped capabilities are issued after human wait; a step deadline starts at first prepare, not before review.

Artifacts: qc_metrics.jsonl.gz, qc_summary.json (bounded summaries and histogram bins), selection.jsonl.gz and filtered.h5ad. Web renders accessible SVG distributions plus numeric tables; it never scans matrices. All artifacts use conditional immutable PUT plus exact streamed GET SHA/size verification. Science receives only scoped opaque capabilities and execution parameters, never control-plane JWT, DB/admin, billing or R2 master credentials. URLs and data arrays are excluded from audits and persistence metadata.

FILTER uses the persisted decision-bound mask, verifies canonical/parameter/selection checksums and ordered identities, retains every gene and exact selected raw counts/metadata, then independently validates the serialized output. It creates a FILTERED_DATASET artifact with canonical/QC/decision-mask lineage; canonical.h5ad and dataset_versions scientific truth are never overwritten. Completed registration is atomic with filter_committed. Cancellation before registration prevents publication authority; an already uploaded unregistered object can be orphaned. After commit, completion wins cancellation. Decision/artifact/lineage UPDATE and DELETE are rejected by database triggers, including owner connections.

## Configuration and qualification

Web requires QC_PIPELINE_VERSION, QC_ANALYSIS_CEILINGS_JSON and QC_FILTER_CEILINGS_JSON. These are operator-approved ExecutionCeilings, not browser settings or biological thresholds. CPU resource class and maxMemoryClass must match; maxRuntimeSeconds is at most 3300, leaving capability handoff margin. Modal CELLWEAVE_MODAL_QC_PROFILE_JSON selects the corresponding CPU/memory allocation; when omitted the existing explicitly configured native profile is reused. Larger inputs require an operator-selected validated profile, never automatic unbounded escalation. Small QC/filter fixtures use CPU_SMALL; large Scrublet workloads should be qualified with CPU_MEMORY/CPU_HIGH_MEMORY against actual input ceilings.

Migration 0006 adds master-design artifacts/lineage and immutable QC Decisions, supplemental revision/delivery state and run/step QC context. Apply through normal environment migration review; local tests apply only to disposable PostgreSQL. No cloud deployment/apply is part of implementation.

Recovery qualification uses a real local Temporal server, separate SIGKILL-able Node workers, PostgreSQL runtime permissions and the real web application service, plus real Python QC/preview/filter computation. The external provider and storage transports are durable local fixtures, not live Modal/R2. Live DEV qualification is separate and must remain NOT RUN without deployed credentials. See orchestrator tests/recovery/qc-worker-loss.test.ts for acknowledgment-loss and cancellation barriers.

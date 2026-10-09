---
trigger: model_decision
description: "Use for comments, shared projects, activity, annotations, reports, exports, search, retention, deletion, suspension, or organization governance."
---

# Collaboration / Search / Reports / Retention

Collaboration:
- comments may target project, dataset, analysis run, cluster, comparison, report
- annotation changes record before, after, actor, timestamp, reason, source
- shared project access remains project-permission scoped
- activity reflects durable audit/domain events

Search V1:
- projects
- datasets
- experiments
- analysis runs
- users
- Postgres search is sufficient
- do not introduce Elasticsearch/OpenSearch prematurely

Reports:
- generated asynchronously
- include project/dataset/pipeline/QC/clustering/annotations/markers/comparisons/DE/pathways/provenance/limitations
- reports are artifacts, never separate truth

Exports:
processed H5AD, CSV, figures, QC, DE, pathways, reports, reproducibility bundle.

Retention:
organization settings cover source, derived, failed-run, and export retention.
Plans constrain allowable limits.

Deletion:
ACTIVE → SOFT_DELETED → RECOVERY_WINDOW → PURGE_PENDING → PURGED.
Organization deletion requires Owner auth, confirmation, optional export, grace period, scheduled purge.

Suspension/payment recovery never equals immediate irreversible purge.

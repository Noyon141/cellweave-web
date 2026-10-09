---
trigger: model_decision
description: "Use for dashboard, project pages, analysis wizard, results, plots, QC review, provenance, exports, errors, reports, comments, or notifications."
---

# Scientific Product UI Rules

Dashboard is operational, not decorative:
- active projects
- recent analyses
- failed analyses
- QC-review-required
- compute usage
- storage usage
- team activity

Project page:
Overview, Experiments, Samples, Datasets, Analysis Runs, Comparisons, Comments, Exports, Activity.

Analysis wizard:
1. dataset
2. metadata review
3. pipeline
4. validated parameters
5. estimated compute usage
6. start

No unexpected compute.

Results sections:
Overview, QC, UMAP, Clusters, Cell Types, Markers, Differential Expression, Pathways, Comparisons, Artifacts, Provenance, Activity.

Every chart answers:
- what is shown
- which run generated it
- which parameters
- how to export underlying values

Browser never downloads full multi-gigabyte H5AD just to render UMAP.

Use optimized visualization artifacts.
Rendering abstraction may switch:
- Canvas for smaller datasets
- WebGL for larger datasets

QC:
- show sample-aware distributions/metrics/doublets/suggested thresholds
- user confirms filters
- do not silently apply universal destructive thresholds

Errors:
use domain-aware code + user message + technical detail + recommended action + support correlation id.
Generic 500 is not the primary scientific error UX.

Notifications:
in-app + Resend for design-specified events.
Never email raw scientific results unless intentionally exported.

Provenance UI is a first-class feature.

Reports are async artifacts, never a separate source of truth.

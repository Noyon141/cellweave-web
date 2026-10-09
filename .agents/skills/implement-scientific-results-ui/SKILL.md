---
name: implement-scientific-results-ui
description: Builds CellWeave dashboard/results/QC/provenance visualization UI using optimized artifacts, progressive loading, accessibility, and scientific context requirements.
---

# Implement Scientific Results UI

1. Identify the exact result artifact(s) and provenance metadata.
2. Never fetch entire H5AD solely for visualization.
3. Use optimized coordinates/index/metadata artifacts.
4. Use the rendering abstraction; choose Canvas/WebGL only according to data-size behavior already defined.
5. Show what the chart means, source run, parameters, and underlying export.
6. Preserve QC review gate and suggested-vs-confirmed distinction.
7. Surface scientific warnings from structured run state/provenance.
8. Keep desktop high-density experience primary; provide functional mobile review.
9. Meet WCAG 2.2 AA; do not encode meaning by color alone.
10. Respect reduced motion and standardized animation components.
11. Test loading, empty, warning, error, large-result, and permission states.

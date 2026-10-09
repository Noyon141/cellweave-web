---
trigger: always_on
description: "Preserves CellWeave's web/business boundary and five-repository architecture."
---

# Web Architecture Boundaries

The web repository may orchestrate business application behavior through application services and Temporal client calls, but must never execute the scientific pipeline.

Never:
- import scientific Python runtime concerns into this repository
- execute Scanpy/scvi-tools from Next.js
- implement Temporal workflow definitions here
- use Postgres as blob/scientific-matrix storage
- use R2 metadata as authorization state
- derive entitlements directly from Polar responses at point of use
- create a second handwritten cross-language contract when `cellweave-contracts` owns it
- collapse `/(ops)` authorization into customer authorization

Provider-specific logic belongs behind infrastructure adapters:
- R2 behind object-storage boundary
- Polar behind billing provider
- notifications behind notification provider
- Temporal behind orchestration client/application boundary

Future enterprise modes and V2 features remain architectural readiness only unless explicitly requested by the authoritative design phase/task.

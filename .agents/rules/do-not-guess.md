---
trigger: always_on
description: "Prevents Antigravity from converting unspecified CellWeave details into permanent architecture."
---

# Do Not Guess

Read `docs/architecture/DO-NOT-GUESS.md`.

Never silently choose a permanent provider, package manager, pricing rule, limit, algorithm, retention duration, rate number, analytics vendor, log backend, feature-flag vendor, or enterprise implementation when the design does not select it.

Inspect existing authorized repository decisions first. If none exist, implement only the explicit abstraction/scaffolding and report the unresolved input.

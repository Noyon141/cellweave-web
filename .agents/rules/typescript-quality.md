---
trigger: glob
description: "Applies mandatory TypeScript safety and domain modeling rules."
globs: "**/*.ts, **/*.tsx"
---

# TypeScript Quality

Mandatory:
- strict TypeScript
- no `any`
- no unreasoned unsafe assertions/casts
- validate untrusted request/webhook/integration data with Zod or generated schema validation
- explicit domain types
- discriminated unions for finite states
- exhaustive switches
- generated contract types for cross-repository payloads
- domain identifiers may be branded to prevent identifier mixing

Do not duplicate OpenAPI/event/run-manifest/artifact-manifest interfaces by hand.

When a state machine changes, update every exhaustive consumer and tests.

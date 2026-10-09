---
trigger: model_decision
description: "Use for Polar, plans, entitlements, credits, usage projection, payment recovery, billing webhooks, or customer portal."
---

# Billing Rules

Provider: Polar.

Commercial model:
subscription + included credits + metered usage.

Source-of-truth split:
- CellWeave immutable usage ledger = operational usage/entitlement/reconciliation truth
- Polar = commercial billing system

Application derives local entitlements. Polar never directly decides if analysis may run.

Entitlements include:
maxUsers, maxProjects, storageBytes, includedComputeCredits, concurrentRuns, retentionDays, advancedML, SSO, auditExport, priorityCompute.

Use `PlanDefinition` + `Entitlement`; do not scatter plan-name conditionals.

Usage billing flow:
step completion → usage event → usage_ledger → billing outbox → Polar event → acknowledgement.

Billing idempotency:
`runId:stepId:attempt`.

Webhook:
- verify signature
- unique external event id
- persist receipt before business processing
- retry safe
- dead-letter visibility

Billing is organization-scoped.

Payment recovery:
- do not immediately delete scientific data
- product may restrict new expensive analyses while allowing view/export
- retention/deletion is separate

Do not invent prices, credit conversion, exact limits, or retention values when absent from design.

---
name: change-billing
description: Changes Polar integration, usage projection, entitlements, credits, payment recovery, or billing UI without making Polar the product entitlement source of truth.
---

# Change Billing

1. Identify whether change affects commercial billing, local usage ledger, entitlements, or both.
2. Preserve local immutable usage ledger as operational source of truth.
3. Keep Polar behind `BillingProvider`.
4. Do not hardcode plan names in domain logic.
5. Maintain organization-scoped billing mapping.
6. Make webhook processing signature-verified, persisted-first, idempotent, replay-safe, and dead-letter visible.
7. Preserve usage idempotency `runId:stepId:attempt`.
8. Reconcile outbox events and acknowledgements.
9. Do not delete scientific data merely because payment is past due.
10. Test duplicate webhooks/events and payment-recovery state behavior.
11. Do not invent prices, exact credit conversion, limits, or retention durations.

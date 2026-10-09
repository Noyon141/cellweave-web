---
trigger: always_on
description: "Protects CellWeave's Research Use Only, PHI prohibition, analytics minimization, and secret boundaries."
---

# RUO, Privacy, Analytics, Secrets

The UI and Terms must communicate:
- Research Use Only
- Not for diagnostic use
- Not intended for clinical decisions

PHI is prohibited in V1.

Do not add:
- patient management
- diagnosis
- treatment recommendation
- clinical decision support

Product analytics may contain operational events only.

Never send ordinary analytics:
- gene names
- patient identifiers
- scientific matrices
- biological conclusions

Third-party analytics receives minimum operational metadata.
Scientific data flows only through providers necessary to operate CellWeave.
Maintain subprocessor inventory.

Never put secrets in:
- Git
- browser bundles
- scientific artifacts
- run manifests
- logs

Separate secrets by environment and rotate independently.

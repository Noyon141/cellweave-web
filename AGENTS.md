# CellWeave Web — Agent Constitution

## Authority
The authoritative architecture is `docs/architecture/CellWeave-Production-Master-System-Design-v1.0.pdf`.
Operational mirrors in `docs/architecture/` help navigation but never override the PDF.

Never invent, add, remove, reinterpret, or silently "improve" CellWeave scope. If a requirement is not selected by the design, follow `docs/architecture/DO-NOT-GUESS.md`.

## Repository responsibility
This repository owns the SaaS/web/business boundary:
- Next.js App Router / React / TypeScript
- shadcn/ui, Tailwind, Motion
- BetterAuth
- Drizzle / Neon metadata access
- R2 integration
- Polar integration
- Temporal client
- customer application
- `/(ops)` operations console
- `/api/v1/*`
- internal API routes
- Polar webhooks

It does not own scientific computation or Temporal workflow implementation.

## Mandatory architecture
- Keep Route Handlers thin: authentication → validation → authorization → application service → response mapping.
- Business/scientific workflows do not live in route files.
- Server Actions are UI ergonomics only and call the same application layer.
- Every tenant-owned request resolves a server-validated `TenantContext`.
- Never trust browser-supplied `organizationId`.
- Every protected object ultimately resolves to `organizationId`.
- Large scientific files upload directly from browser to private R2 with authorized signed/multipart operations; never proxy them through Vercel.
- Postgres stores structured operational/scientific metadata, not large scientific matrices.
- R2 stores heavy artifacts, never permissions.
- Polar is commercial billing, never the entitlement source of truth.
- Scientific runs are asynchronous. No UI request waits for a scientific pipeline.
- Public scientific object URLs are forbidden.

## TypeScript
Strict TypeScript is mandatory. No `any`. Avoid unsafe casts. Validate external/request data. Use explicit domain types, discriminated unions, exhaustive switches, and generated contract types.

## RUO / privacy
CellWeave is Research Use Only, non-diagnostic, processed-data-first, and prohibits PHI.
Do not add patient-management, diagnostic, treatment, or clinical-decision features.

## Completion
A feature is incomplete until authorization, tenant isolation, errors, observability, tests, documentation, and design invariants are satisfied.

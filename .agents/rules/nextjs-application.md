---
trigger: glob
description: "Enforces the CellWeave Next.js App Router organization, SSR strategy, UI boundaries, and performance model."
globs: "src/**/*.ts, src/**/*.tsx"
---

# Next.js Application Rules

Use App Router.

Feature/domain organization:
- `src/app/` for routes/composition
- `src/features/` for feature modules
- `src/server/domain/`
- `src/server/application/`
- `src/server/infrastructure/`
- `src/server/authorization/`
- `src/server/database/`
- `src/server/storage/`
- `src/server/integrations/`
- `src/components/ui/`
- `src/components/scientific/`
- `src/components/animations/`
- `src/types/`

Expected route groups include:
- `(marketing)`
- `(auth)`
- `(app)`
- `(ops)`
- `api/auth`
- `api/v1`
- `api/internal`
- `api/webhooks/polar`

Performance:
- Server Components for data-heavy initial views.
- Client Components only for interactive plots, forms, filters, animations, and live run status.
- TanStack Query for dynamic client data.
- Axios is part of the final application baseline.
- Do not turn the dashboard into a client-rendered SPA.
- Scientific work is asynchronous.
- Result visualizations progressively load.

Animations:
- standardize under `components/animations/`
- use ModalAnimations, FormAnimations, PageAnimations, ResultAnimations patterns
- respect `prefers-reduced-motion`
- animation must not slow scientific navigation

Responsive:
- desktop primary
- laptop/tablet/mobile review remains functional
- mobile supports status, comments, basic charts, notifications, billing, project review
- complex UMAP may use reduced interaction on small screens

Accessibility target: WCAG 2.2 AA.
Scientific plots may not communicate meaning by color alone.

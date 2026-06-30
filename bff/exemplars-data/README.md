# Exemplar library — what goes here and how to add to it

This folder holds the **few-shot design exemplars**: each `.tsx` file is one
gold-standard `App.tsx` that the build prompt shows the model as a reference for
*how good the output should look*. Design is shown, not told — one excellent
dashboard teaches spacing, hierarchy, and polish better than prose rules.

It's wired so that an **absent file is simply skipped** (the registry entry
contributes an empty string and de-selects). Nothing breaks with a partial
library; missing domains fall back to `generic`.

## Filename → domain mapping

Each file is bound to a domain by a row in `bff/exemplars.ts` (`REGISTRY`):

| file                  | domain        | status        |
|-----------------------|---------------|---------------|
| `sales.tsx`           | `sales`       | seeded        |
| `web_analytics.tsx`   | `web_analytics` | seeded      |
| `support.tsx`         | `generic`     | seeded (fallback for any unmatched domain) |
| `finance.tsx`         | `finance`     | **open — add one** |
| `marketing.tsx`       | `marketing`   | **open — add one** |
| `crm.tsx`             | `users_crm`   | **open — add one** |

To add an exemplar for an existing domain, just drop the `.tsx` file with the
name above. To add a **new** domain, add the `.tsx` here *and* a `REGISTRY` row
in `bff/exemplars.ts` (and make sure the domain string matches the detector's
`Domain` union in `bff/domain.ts`).

## How to harvest one (the intended way)

1. Generate a dashboard for the domain with a strong prompt and real-ish data.
2. Iterate until the output is genuinely excellent — this is the bar the model
   will imitate, so don't settle.
3. Copy the generated `App.tsx` into a file here.
4. **Clean it:** remove the `//__SUMMARY__` first line and the trailing
   `//__END__` marker; make sure it starts with the `import` lines and ends with
   the `export default function App` (no prose, no fences).

## The contract every exemplar must follow

An exemplar is only a good teacher if it obeys the same runtime contract the
model is told to produce. Keep all of these true:

- **Imports only** from `react`, `recharts` (chart primitives only), `lucide-react`,
  `./data` (`query`, `rows`, `tables`), and `./selection` (`selectFeature`). No
  other package, no CSS imports.
- **Data only through `./data`** — aggregate in SQL via `query(...)`; never hardcode rows.
- **One accent** (indigo-600 family) on a slate canvas; emerald/rose only for deltas.
- **Loading skeleton + empty/error state** both present.
- `export default function App`.
- Treats DATE/TIMESTAMP columns as real temporal types (use date functions, not string ops).

## Verify before committing

- `npm run test:exemplars` — confirms the library loads and selection works.
- `npm run typecheck` — should stay silent (this folder is excluded from tsc, since
  these files are reference *data*, not compiled source).
- Optional but recommended: run `npm run test:eval:live` before and after adding
  exemplars. The eval's **leakage** scorer will flag if generations start copying
  an exemplar's literal labels verbatim (stenciling) — if that happens, make the
  exemplar's copy less generic or vary it.

## A/B switch

Set `T2UI_NO_EXEMPLARS=1` to disable exemplar injection entirely, to compare build
quality with vs without the few-shot reference.

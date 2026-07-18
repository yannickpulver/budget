# newbudget

An open-source, self-hosted YNAB alternative — envelope budgeting, CSV bank
import, and investment tracking. See [`PLAN.md`](./PLAN.md) for the full
spec.

## Status

Foundation stage: schema, budget-math library, and a generic YNAB migration
importer are in place. The budget UI itself is not built yet.

## Stack

Next.js (App Router) + TypeScript, Tailwind 4 + shadcn/ui, Drizzle ORM +
SQLite (better-sqlite3).

## Development

```bash
pnpm install
pnpm db:push      # create/update the SQLite schema at data/budget.db
pnpm dev
```

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test
```

## YNAB migration

Drop your YNAB export's `Register.csv` and `Plan.csv` into a local `plan/`
directory (gitignored — never commit personal financial data), then run:

```bash
pnpm migrate:ynab
```

This wipes and reimports `data/budget.db` from the two CSVs, then prints a
verification report comparing recomputed category balances against YNAB's
own `Plan.csv` values.

## License

MIT — see [`LICENSE`](./LICENSE).

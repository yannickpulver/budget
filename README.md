# newbudget

An open-source, self-hosted envelope budgeting app — a private alternative to
YNAB you run yourself. Every unit of currency gets assigned to a category
("give every dollar a job"), accounts track real balances, and a generic
migration path gets your history out of YNAB and into your own database.

No accounts, no subscriptions, no telemetry. Your data lives in one SQLite
file that you own.

## Features

- **Budget view** — month-by-month Ready to Assign, category groups,
  Assigned / Activity / Available per category, inline assign, overspending
  highlighted.
- **Accounts & register** — checking/savings/cash/credit/tracking accounts,
  a searchable transaction register, transfers between accounts.
- **CSV import** — one-time YNAB migration (full history) plus ongoing
  per-account bank-statement import with duplicate detection and a preview
  before anything is committed.
- **Monthly goals** — set a monthly assignment target on a category (e.g.
  "Subscriptions: CHF 120/month"); the budget view flags underfunded
  categories and offers a one-click "fund to goal".
- **Investments** — track holdings (symbol + quantity) on a tracking
  account, with on-demand price fetching and a "sync balance" action.
- **Credit cards** — YNAB-style payment-category funding: spending on a
  credit account keeps its payment category funded automatically.
- **Category management** — create, rename, and hide category groups and
  categories from Settings → Categories.

## Screenshots

_Add screenshots of the budget view, account register, and import flow
here._

## Quick start

### Docker (recommended)

```bash
git clone https://github.com/<you>/newbudget.git
cd newbudget
docker compose up -d
```

This builds the image, creates `./data/budget.db` on first run, and serves
the app on [http://localhost:3000](http://localhost:3000). The database file
lives entirely in `./data` on the host — back that directory up and you have
your whole budget.

To use a prebuilt image instead of building locally, edit
`docker-compose.yml`'s `image:` line once you've published one.

### Manual (pnpm)

Requires Node 20+ and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm db:push      # create the SQLite schema at data/budget.db
pnpm build
pnpm start
```

Or for local development: `pnpm dev` (auto-reloading, same `data/budget.db`).

The database path defaults to `./data/budget.db` and is configurable via the
`DATABASE_PATH` environment variable (this is how the Docker image points it
at `/data/budget.db` on its volume). A brand-new database file bootstraps
its own schema automatically on first run — `pnpm db:push` is only needed if
you're changing the schema yourself.

### First run

A fresh install starts empty: the sidebar prompts you to add your first
account, and creating it seeds a small starter set of categories (Spending,
Bills, Saving groups with a handful of common categories inside). Rename,
hide, or delete anything you don't need from Settings → Categories — nothing
about the starter set is special or hardcoded into the budget logic.

## Migrating from YNAB

The migration is a one-time CLI script — it wipes and reimports the local
database from two CSV files you export from YNAB, so it's meant to be run
once, before you start using newbudget day to day.

1. In YNAB, export your budget: **Budget → (menu) → Export Budget Data**. You
   get a zip with, among others, `Register.csv` and `Plan.csv` for the
   budget you exported.
2. Create a `plan/` directory at the repo root (gitignored — never commit
   personal financial data) and drop both CSVs into it.
3. Run the migration:

   ```bash
   pnpm migrate:ynab
   ```

4. Read the verification report the script prints. It recomputes each
   category's Available for the last 12 months from the imported
   transactions/assignments and diffs that against the Available YNAB itself
   reported in `Plan.csv`. A 100% match rate on non-credit-card categories
   means the import reproduces YNAB's numbers exactly; any mismatches are
   listed with the category, month, and expected-vs-actual amounts so you
   can investigate before trusting the import.

   **Credit-card payment categories are reported separately and don't gate
   the import.** YNAB's internal credit-card bookkeeping (immediate category
   funding, adjustments that never make it into the CSV export) isn't fully
   reconstructable from Register.csv/Plan.csv alone, so a from-scratch
   replay of a payment category's Available can drift slightly from what
   YNAB reports. The script corrects for this by snapping each payment
   category to YNAB's own Plan.csv value as of the export date — expect (and
   ignore) informational diffs on payment categories in the report; they
   don't indicate an import bug.

5. YNAB's export doesn't include goal/target data, so monthly targets need
   to be re-entered by hand afterwards (Settings → Categories or the target
   icon on the budget view) — usually just a handful of categories.

## Ongoing CSV import

Each account page has an **Import CSV** button for adding bank-statement
transactions after the initial migration. It expects YNAB's Register column
format:

| Column                                   | Required | Notes                                                                |
| ----------------------------------------- | -------- | --------------------------------------------------------------------- |
| `Date`                                    | yes      | `DD.MM.YYYY`                                                          |
| `Payee`                                   | yes      |                                                                         |
| `Outflow`                                 | yes      | `CHF 12.34`, `-CHF 12.34`, or a plain number; blank = 0               |
| `Inflow`                                  | yes      | same formats as Outflow                                               |
| `Memo`                                    | no       |                                                                         |
| `Category` or `Category Group/Category`   | no       | matched by name (case-insensitive) against your existing categories   |

Most bank-export-to-YNAB converters produce this format directly. Rows are
previewed before import — each is flagged NEW or DUPLICATE (matched by
account + date + amount + payee) so you can uncheck anything already
present, and unmatched categories simply come in uncategorized rather than
blocking the import.

## Investments & privacy

Tracking-account holdings (symbol + quantity) get priced via Yahoo Finance's
unofficial, keyless quote endpoint. **This is the only outbound network call
the app ever makes**, and it only happens when you view a tracking account
with stale/missing prices or click "Refresh prices" — never automatically in
the background, never with any of your budget data attached. Everything
else — every transaction, category, and balance — stays on your machine (or
your server) in the SQLite file.

## Tech stack

- [Next.js](https://nextjs.org) (App Router) + TypeScript, server actions,
  no separate API layer.
- Tailwind CSS 4 + [shadcn/ui](https://ui.shadcn.com) (light theme only).
- SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) +
  [Drizzle ORM](https://orm.drizzle.team) — a single file in `data/`,
  volume-mounted in Docker.
- [Vitest](https://vitest.dev) for the budget-math, import, and query test
  suite.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test
```

## License

MIT — see [`LICENSE`](./LICENSE).

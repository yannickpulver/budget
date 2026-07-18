# newbudget — self-hosted YNAB replacement

## Context

An **open-source, self-hostable, private YNAB alternative** — built for anyone who wants to run their own budgeting app instead of trusting a SaaS with their financial data. Core: envelope budgeting (assign every unit of currency), accounts with transactions, CSV import of bank statements, and tracking accounts for investments. Fresh build in this repo, informed by earlier findings on YNAB's math rules and export-format quirks (known-good knowledge, reused here rather than rediscovered).

**Open source means**: nothing personal hardcoded, empty-state onboarding for new users, YNAB migration as a generic feature, personal data never committed (`plan/` and `data/` gitignored — any maintainer's own export is a local test fixture only), MIT license, README with setup + Docker instructions.

## Decisions (made with user)

- **Fully fresh rewrite** in `newbudget/`. Nothing copied from the old repo.
- **Investments**: holdings (symbol, quantity) per tracking account with **auto price fetch** (Yahoo Finance unofficial quote API, cached in DB).
- **No auth** — network-level protection assumed (localhost/Tailscale/reverse proxy).
- **Light mode** UI, shadcn/ui, no AI-slop styling.
- Single currency per budget, configurable (default CHF). Amounts stored as integer minor units (Rappen/cents).
- **Open source (MIT)** — generic product; any personal YNAB export used for local testing is a private local fixture, never in git.

## Scope

### In
- Empty-state onboarding: new users start with a first account + a small default category set (editable/deletable) — no import required.
- Budget view (the heart): month nav, Ready to Assign, category groups, Assigned / Activity / Available per category, inline assign, overspending highlighted.
- Sidebar: accounts grouped (Budget / Tracking) with balances; create/edit/close accounts.
- Account register: list, add/edit/delete transaction, transfer support, cleared toggle, **search** (payee/memo/category/amount).
- CSV import, two kinds:
  1. One-time YNAB migration (Register + Plan) — generic feature for anyone leaving YNAB; full history.
  2. Ongoing per-account import in YNAB Register column format, with duplicate detection + preview before commit.
- Category management: create/rename/hide groups + categories.
- **Monthly goals** (one type only): a category can have a monthly assignment target (e.g. Subscriptions CHF 120/month). The goal is met when `assigned(cat, M) ≥ target` — spending doesn't affect it. Budget view shows underfunded categories (amber, "CHF x to go") and a quick "fund to goal" fill on the assign input; header shows total still needed this month.
- Investments: holdings per tracking account, auto price fetch, "sync balance" writes an adjustment transaction so the account balance matches market value.
- Credit card: YNAB-style — categorized spending on a credit account feeds a payment category so the payment is always funded (derived at compute time, not stored).

### Out (deliberately)
- Other goal types (target balance, by-date, spending goals — only the monthly assignment target exists), reports/graphs (later maybe), reconciliation flow, flags (0 usage in 6 years of data), split transaction entry (historical splits import as separate rows), multi-budget, multi-currency, multi-user/auth, mobile apps.

## Stack

- Next.js (App Router) + TypeScript, server actions, no separate API layer.
- Tailwind 4 + shadcn/ui (light theme).
- SQLite via better-sqlite3 + Drizzle ORM. Single file DB in `data/`, volume-mounted in Docker.
- Docker single-container for self-hosting.
- pnpm. Vitest for budget-math unit tests. Git from day one.

## Data model

- `accounts` — id, name, type (`checking|savings|cash|credit|tracking`), closed, sort
- `category_groups` — id, name, sort, hidden
- `categories` — id, group_id, name, sort, hidden, monthly_target? (Rappen, null = no goal)
- `transactions` — id, account_id, date (ISO), payee, category_id?, memo, amount (Rappen, +in/−out), cleared, transfer_account_id?, import_hash?
- `assignments` — PK (month `YYYY-MM`, category_id), amount
- `holdings` — id, account_id (tracking), symbol, name, quantity
- `prices` — symbol, price_rappen, fetched_at

Transfers = two linked rows (each row stores `transfer_account_id`; edits/deletes update both legs — fix the old attempt's known desync gap).

## Budget math (YNAB semantics)

- `activity(cat, M)` = Σ categorized txn amounts in M (on-budget accounts).
- `available(cat, M) = max(0, available(cat, M−1)) + assigned(cat, M) + activity(cat, M)` — overspend does NOT roll forward; it comes out of next month's Ready to Assign.
- `readyToAssign(M) = on-budget funds through M − Σ available(cat, M)`.
- Credit account spend feeds its payment category's activity (derived).
- Cache computed month snapshots (old attempt recomputed the full 73-month walk per request — memoize per month, invalidate on write).

## YNAB import — format facts (verified against the real export)

- UTF-8 **with BOM**, CRLF, RFC4180 quoting; amount columns are **unquoted** → must use a real CSV parser.
- Amounts: `CHF 1234.56`, negatives `-CHF 79.60`. Dates `DD.MM.YYYY`.
- Transfers: payee `Transfer : <Account>`, two rows. Both-on-budget → category blank both sides. To tracking account → on-budget side categorized (e.g. `5. Saving / Investing: Swissquote`).
- Income rows: category `Inflow: Ready to Assign` (497 rows). `Starting Balance` payee rows same.
- Splits: separate rows with memo `Split (n/m) ` — import as-is as independent transactions.
- `Hidden Categories` group (66 legacy categories) → import hidden.
- 147 legit full-duplicate rows exist → migration must NOT dedupe. Ongoing imports DO dedupe by hash (account, date, amount, payee) with user preview.
- YNAB's export contains no goal/target data → monthly targets are re-entered manually after migration (a few minutes; only a handful of categories have them).
- Verification step: after migration, recompute Available per category for recent months and diff against the *uploaded* Plan.csv values, plus recomputed account balances — shown as a report in the UI. Fully generic (works for any YNAB export, no hardcoded expectations); a maintainer's own export doubles as the local integration fixture during development.

## Screens

1. `/budget/[month]` — the heart. RTA banner, group table (Assigned / Activity / Available), inline assign input, month prev/next.
2. Sidebar (persistent) — Budget accounts + balances, Tracking accounts + balances, net worth, + New account.
3. `/accounts/[id]` — register table, search box, add-transaction row, CSV import button.
4. `/accounts/[id]` (tracking) — additionally holdings table: symbol, qty, price, value, day change; refresh prices; sync balance.
5. `/import` — one-time YNAB migration (upload both CSVs, preview counts, run, show verification report).
6. `/settings/categories` — groups/categories manage.

## Build order

1. Scaffold: Next.js + Tailwind + shadcn + Drizzle/SQLite, git init (`.gitignore`: `data/`, `plan/`), MIT license, light theme tokens.
2. Schema + migration importer + verification report. Milestone: a real YNAB export imports and its numbers match YNAB.
3. Budget screen with correct math + unit tests (Vitest) on budget-math. Includes monthly goals (target edit, underfunded indicator, fund-to-goal).
4. Sidebar + account CRUD + register with search + transfers.
5. Ongoing CSV import with duplicate preview.
6. Investments: holdings, Yahoo price fetch (server-side, cached, manual refresh + daily), sync-balance adjustment.
7. Docker image + README (setup, screenshots, YNAB migration guide) + onboarding empty states + polish pass.

## Verification

- Unit tests: budget-math (rollover, overspend reset, RTA identity, credit-card feed).
- Import verification report (computed vs Plan.csv) must show 0 diff on non-credit categories for the last 12 months.
- Manual: run app, import real export, compare RTA + a few category Availables against YNAB screenshots.

## Open questions

1. Import full history since 2020, or cut over at e.g. Jan 2025? (Recommend: full — verification is stronger.)
2. Credit card: keep YNAB-style payment bucket (matches typical YNAB usage) or simpler "pay-in-full" model (card is just an on-budget account, payment = plain transfer)? Plan assumes YNAB-style.
3. Yahoo Finance (unofficial, keyless) OK as price source, or prefer a keyed API?

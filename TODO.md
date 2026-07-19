# Todo

- **Detect external DB changes**: the in-process budget cache (SnapshotStore/loadBudgetData) misses writes from other processes (e.g. `migrate:ynab` while the server runs) — check SQLite `PRAGMA data_version` per read and invalidate when it changes, so a restart isn't needed.

- **Swissquote report import**: on tracking accounts, import a Swissquote trade/transaction report to create and update holdings from actual buys/sells (date, symbol, quantity, price) instead of manual entry. Ideally classify dividends, fees, and FX lines too.
  Blocked on: a real sample export in `plan/` (gitignored) to build the parser against — formats vary by report type and language.
- Build the Docker image once on a machine with a running Docker daemon (`docker build .`) — Dockerfile is reviewed but has never been built.
- Screenshots for the README.

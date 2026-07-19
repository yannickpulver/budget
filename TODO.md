# Todo

- **Swissquote report import**: on tracking accounts, import a Swissquote trade/transaction report to create and update holdings from actual buys/sells (date, symbol, quantity, price) instead of manual entry. Ideally classify dividends, fees, and FX lines too.
  Blocked on: a real sample export in `plan/` (gitignored) to build the parser against — formats vary by report type and language.
- Build the Docker image once on a machine with a running Docker daemon (`docker build .`) — Dockerfile is reviewed but has never been built.
- Screenshots for the README.

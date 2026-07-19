import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { buildSwissquotePreview, commitSwissquoteImport, getHoldingsView, type SwissquoteRowInput } from "./queries";
import { parseStatementText, type ParsedStatement } from "./swissquote-import";

/**
 * DB-backed half of the Swissquote importer: holding quantity updates,
 * deposit-vs-existing-transaction matching, and the two idempotency layers
 * (whole-statement via import_batches, per-row via imported_statement_rows).
 * Pure parsing is covered separately in swissquote-import.test.ts. Same
 * throwaway in-memory SQLite fixture pattern as csv-import.test.ts — never
 * touches data/budget.db.
 */

let sqlite: Database.Database;

function makeDb() {
  return drizzle(sqlite, { schema });
}

const DDL = `
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  payment_category_id INTEGER
);
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  payee TEXT NOT NULL DEFAULT '',
  category_id INTEGER,
  memo TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  cleared INTEGER NOT NULL DEFAULT 0,
  transfer_account_id INTEGER,
  import_hash TEXT,
  transfer_pair_id TEXT
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL DEFAULT 0
);
CREATE TABLE prices (
  symbol TEXT PRIMARY KEY,
  price_rappen INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  currency TEXT,
  fx_rate REAL,
  fetch_error TEXT
);
CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  count INTEGER NOT NULL,
  committed_at TEXT NOT NULL
);
CREATE TABLE imported_statement_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  import_hash TEXT NOT NULL,
  committed_at TEXT NOT NULL
);
`;

const TRACKING = 1;

function seed() {
  sqlite.exec(DDL);
  sqlite.exec(`
    INSERT INTO accounts (id, name, type) VALUES (${TRACKING}, 'Brokerage', 'tracking');
    INSERT INTO settings (key, value) VALUES ('currency', 'CHF');
  `);
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  seed();
});

afterEach(() => {
  sqlite.close();
});

// A single-buy, single-deposit, single-fee, single-(foreign-currency)-dividend
// statement — enough to exercise every preview/commit branch without the
// bulk of swissquote-import.test.ts's fixture.
function fixture(period: { start: string; end: string } = { start: "01.01.2026", end: "31.01.2026" }): string {
  return `Kontoauszug vom \t${period.start} bis ${period.end}
Kontoauszug in CHF
Saldo per ${period.start} \t100.00 CHF
Total Belastung \t456.00 CHF
Total Gutschrift \t500.00 CHF
Saldo per ${period.end} \t144.00 CHF
DATUM \tINFORMATION \tREFERENZ \tBELASTUNG \tGUTSCHRIFT \tVALUTA-DATUM \tSALDO (CHF)
01.01.2026 \tAnfangsbestand \t100.00
15.01.2026 \tZahlung von
Muster Max
100000001 \t500.00 \t15.01.2026 \t600.00
16.01.2026 \tKauf
Test Fund UCITS ETF
(TEST)
Anzahl: 3
Preis: CHF 150.00
Betrag: CHF 450.00
Kommission: CHF 5.00
Taxen: CHF 1.00
Handelsplatz: SIX Swiss Exchange
ISIN: CH0000000001
100000002 \t456.00 \t18.01.2026 \t144.00
31.01.2026 \tSchlussbilanz \t144.00
Kontoauszug in USD
Saldo per ${period.start} \t0.00 USD
Total Belastung \t0.00 USD
Total Gutschrift \t0.85 USD
Saldo per ${period.end} \t0.85 USD
DATUM \tINFORMATION \tREFERENZ \tBELASTUNG \tGUTSCHRIFT \tVALUTA-DATUM \tSALDO (USD)
01.01.2026 \tAnfangsbestand \t0.00
20.01.2026 \tDividende
ACME ORD (ACME)
Anzahl: 5
Betrag: USD 1.00
Taxen: USD 0.15
Total: USD 0.85
200000001 \t0.85 \t20.01.2026 \t0.85
31.01.2026 \tSchlussbilanz \t0.85
`;
}

function parse(text: string): ParsedStatement {
  const result = parseStatementText(text);
  if (!result.ok) throw new Error(result.error);
  return result.statement;
}

function checkedRows(rows: ReturnType<typeof buildSwissquotePreview>["rows"]): SwissquoteRowInput[] {
  return rows
    .filter((r) => r.bookable && !r.isDuplicate && !r.exists)
    .map((r) => ({
      statementKey: r.statementKey,
      kind: r.kind,
      date: r.date,
      amount: r.amount,
      quantity: r.quantity,
      yahooSymbol: r.yahooSymbol,
      name: r.name,
      payee: r.payee,
      importHash: r.importHash,
    }));
}

describe("buildSwissquotePreview", () => {
  it("excludes boundary rows and marks the foreign-currency dividend info-only", () => {
    const dbi = makeDb();
    const preview = buildSwissquotePreview(dbi, TRACKING, [parse(fixture())]);

    expect(preview.rows.map((r) => r.kind)).toEqual(["deposit", "buy", "dividend"]);
    const dividend = preview.rows.find((r) => r.kind === "dividend")!;
    expect(dividend.currency).toBe("USD");
    expect(dividend.bookable).toBe(false);
  });

  it("shows the resulting holding quantity for a buy, seeded from any existing holding", () => {
    const dbi = makeDb();
    sqlite.exec(`INSERT INTO holdings (account_id, symbol, name, quantity) VALUES (${TRACKING}, 'TEST.SW', 'Test Fund', 2)`);

    const preview = buildSwissquotePreview(dbi, TRACKING, [parse(fixture())]);
    const buy = preview.rows.find((r) => r.kind === "buy")!;
    expect(buy.quantity).toBe(3);
    expect(buy.resultingQuantity).toBe(5); // 2 existing + 3 bought
  });

  it("flags a deposit that already has a matching transaction within +/-3 days as EXISTS", () => {
    const dbi = makeDb();
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared) VALUES (${TRACKING}, '2026-01-14', 'Manual entry', 50000, 1)`
    );

    const preview = buildSwissquotePreview(dbi, TRACKING, [parse(fixture())]);
    const deposit = preview.rows.find((r) => r.kind === "deposit")!;
    expect(deposit.exists).toBe(true);
  });
});

describe("commitSwissquoteImport", () => {
  it("applies a buy (creating the holding) and books the deposit as a transaction, in one go", () => {
    const dbi = makeDb();
    const preview = buildSwissquotePreview(dbi, TRACKING, [parse(fixture())]);
    const count = commitSwissquoteImport(dbi, TRACKING, checkedRows(preview.rows));

    expect(count).toBe(2); // deposit + buy; the foreign-currency dividend is info-only and never sent
    const view = getHoldingsView(TRACKING, dbi);
    expect(view.holdings).toHaveLength(1);
    expect(view.holdings[0]).toMatchObject({ symbol: "TEST.SW", quantity: 3 });

    const txns = dbi.select().from(schema.transactions).all();
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ amount: 50000, payee: "Deposit" });
  });

  it("increases an existing holding's quantity rather than creating a duplicate row", () => {
    const dbi = makeDb();
    sqlite.exec(`INSERT INTO holdings (account_id, symbol, name, quantity) VALUES (${TRACKING}, 'TEST.SW', 'Test Fund', 10)`);

    const preview = buildSwissquotePreview(dbi, TRACKING, [parse(fixture())]);
    commitSwissquoteImport(dbi, TRACKING, checkedRows(preview.rows));

    const holdings = dbi.select().from(schema.holdings).all();
    expect(holdings).toHaveLength(1);
    expect(holdings[0].quantity).toBe(13);
  });

  it("is idempotent: re-committing the same statement is a no-op", () => {
    const dbi = makeDb();
    const statement = parse(fixture());

    const firstRows = checkedRows(buildSwissquotePreview(dbi, TRACKING, [statement]).rows);
    const firstCount = commitSwissquoteImport(dbi, TRACKING, firstRows);
    expect(firstCount).toBe(2);

    // Re-preview (as a real re-upload would) shows every bookable row as
    // already-imported...
    const secondPreview = buildSwissquotePreview(dbi, TRACKING, [statement]);
    expect(secondPreview.rows.filter((r) => r.bookable).every((r) => r.isDuplicate)).toBe(true);

    // ...and even force-resubmitting the original checked rows is a hard
    // no-op, because the whole-statement batch guard doesn't trust the
    // client's row selection.
    const secondCount = commitSwissquoteImport(dbi, TRACKING, firstRows);
    expect(secondCount).toBe(0);

    const holdings = dbi.select().from(schema.holdings).all();
    expect(holdings[0].quantity).toBe(3); // unchanged, not doubled
    const txns = dbi.select().from(schema.transactions).all();
    expect(txns).toHaveLength(1); // unchanged, not doubled
  });

  it("does not double-book a row that reappears in a second, overlapping statement", () => {
    const dbi = makeDb();
    const november = parse(fixture({ start: "01.11.2025", end: "30.11.2025" }));
    commitSwissquoteImport(dbi, TRACKING, checkedRows(buildSwissquotePreview(dbi, TRACKING, [november]).rows));

    // A yearly statement covering the same November deposit+buy (same
    // reference numbers, different statement period) must flag them as
    // duplicates rather than re-applying them.
    const yearly = parse(fixture({ start: "01.01.2025", end: "31.12.2025" }));
    const yearlyPreview = buildSwissquotePreview(dbi, TRACKING, [yearly]);
    expect(yearlyPreview.rows.filter((r) => r.kind === "buy" || r.kind === "deposit").every((r) => r.isDuplicate)).toBe(
      true
    );

    // Nothing is checked by default for duplicate rows, so a straight
    // re-commit of the checked set is a no-op too.
    const committed = commitSwissquoteImport(dbi, TRACKING, checkedRows(yearlyPreview.rows));
    expect(committed).toBe(0);
    const holdings = dbi.select().from(schema.holdings).all();
    expect(holdings[0].quantity).toBe(3);
  });
});

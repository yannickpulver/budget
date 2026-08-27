import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import {
  computeImportHash,
  parseGenericAmount,
  parseImportCsv,
  resolveCategoryName,
} from "./csv-import";
import { buildImportPreview, commitImport, findTransferAccountErrors } from "./queries";

/**
 * Ongoing CSV import: pure parsing/hashing (no DB) plus the DB-backed
 * preview/dedupe logic against a throwaway in-memory SQLite fixture (never
 * the real data/budget.db), following the pattern in transfers.test.ts.
 */

describe("parseGenericAmount", () => {
  it("parses YNAB currency-prefixed amounts", () => {
    expect(parseGenericAmount("CHF 12.34")).toBe(1234);
    expect(parseGenericAmount("-CHF 79.60")).toBe(-7960);
  });

  it("parses plain numbers via the fallback parser", () => {
    expect(parseGenericAmount("12.34")).toBe(1234);
    expect(parseGenericAmount("-79.60")).toBe(-7960);
    expect(parseGenericAmount("1'234.50")).toBe(123450);
  });

  it("treats blank input as zero", () => {
    expect(parseGenericAmount("")).toBe(0);
    expect(parseGenericAmount("   ")).toBe(0);
  });

  it("throws on unrecognized input", () => {
    expect(() => parseGenericAmount("not a number")).toThrow();
  });
});

describe("resolveCategoryName", () => {
  it("detects Ready to Assign from the combined Category Group/Category column", () => {
    expect(resolveCategoryName("Inflow: Ready to Assign")).toEqual({ isReadyToAssign: true, name: "Ready to Assign" });
  });

  it("detects Ready to Assign from a bare Category column", () => {
    expect(resolveCategoryName("Ready to Assign")).toEqual({ isReadyToAssign: true, name: "Ready to Assign" });
  });

  it("strips the group prefix from an ordinary combined category", () => {
    expect(resolveCategoryName("Spending: Groceries")).toEqual({ isReadyToAssign: false, name: "Groceries" });
  });

  it("passes through a bare category name unchanged", () => {
    expect(resolveCategoryName("Groceries")).toEqual({ isReadyToAssign: false, name: "Groceries" });
  });

  it("returns null for blank/absent input", () => {
    expect(resolveCategoryName(null)).toEqual({ isReadyToAssign: false, name: null });
    expect(resolveCategoryName("  ")).toEqual({ isReadyToAssign: false, name: null });
  });
});

describe("parseImportCsv", () => {
  it("parses a minimal Date/Payee/Memo/Outflow/Inflow file", () => {
    const csv = Buffer.from(
      "Date,Payee,Memo,Outflow,Inflow\n" +
        "15.03.2025,Coop,Groceries,CHF 42.50,\n" +
        "16.03.2025,Employer,Salary,,CHF 5000.00\n"
    );
    const result = parseImportCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ date: "2025-03-15", payee: "Coop", memo: "Groceries", amount: -4250 });
    expect(result.rows[1]).toMatchObject({ date: "2025-03-16", payee: "Employer", amount: 500000 });
  });

  it("reads the optional Transfer column, leaving it null when absent or blank", () => {
    const csv = Buffer.from(
      "Date,Payee,Memo,Outflow,Inflow,Transfer\n" +
        "21.07.2026,Card Services AG,,CHF 3257.75,,Rewards Credit Card\n" +
        "22.07.2026,Coop,,CHF 42.50,,\n"
    );
    const result = parseImportCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].transferAccountName).toBe("Rewards Credit Card");
    expect(result.rows[1].transferAccountName).toBeNull();
  });

  it("tolerates and ignores Account/Flag columns, and reads Category Group/Category", () => {
    const csv = Buffer.from(
      "Account,Flag,Date,Payee,Category Group/Category,Memo,Outflow,Inflow\n" +
        "Checking,,15.03.2025,Coop,Spending: Groceries,,CHF 42.50,\n"
    );
    const result = parseImportCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].categoryName).toBe("Spending: Groceries");
  });

  it("accepts plain-number amounts (no currency code)", () => {
    const csv = Buffer.from("Date,Payee,Memo,Outflow,Inflow\n15.03.2025,Coop,,42.50,\n");
    const result = parseImportCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].amount).toBe(-4250);
  });

  it("fails structurally when a required column is missing", () => {
    const csv = Buffer.from("Date,Payee,Memo,Outflow\n15.03.2025,Coop,,CHF 42.50\n");
    const result = parseImportCsv(csv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toMatch(/Missing required column/);
  });

  it("reports which line and why on a bad row, importing nothing", () => {
    const csv = Buffer.from(
      "Date,Payee,Memo,Outflow,Inflow\n" +
        "15.03.2025,Coop,,CHF 42.50,\n" +
        "not-a-date,Migros,,CHF 10.00,\n"
    );
    const result = parseImportCsv(csv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ line: 3 });
    expect(result.errors[0].message).toMatch(/date/i);
  });

  it("fails on an empty file", () => {
    const result = parseImportCsv(Buffer.from("Date,Payee,Memo,Outflow,Inflow\n"));
    expect(result.ok).toBe(false);
  });
});

describe("computeImportHash", () => {
  it("is stable for identical inputs and differs when any field changes", () => {
    const a = computeImportHash(1, "2025-03-15", -4250, "Coop");
    const b = computeImportHash(1, "2025-03-15", -4250, "Coop");
    const c = computeImportHash(1, "2025-03-16", -4250, "Coop");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

/**
 * DB-backed preview + commit, against an in-memory SQLite fixture.
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
  payment_category_id INTEGER,
  linked_category_id INTEGER,
  icon TEXT,
  hidden_from TEXT
);
CREATE TABLE category_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  hidden_from TEXT,
  monthly_target INTEGER
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
CREATE TABLE assignments (
  month TEXT NOT NULL,
  category_id INTEGER NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  goal_funded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, category_id)
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  count INTEGER NOT NULL,
  committed_at TEXT NOT NULL
);
`;

const CHECKING = 1;
const SAVINGS = 2;
const BROKERAGE = 3;
const GROCERIES = 10;

function seed() {
  sqlite.exec(DDL);
  sqlite.exec(`
    INSERT INTO accounts (id, name, type) VALUES (${CHECKING}, 'Checking', 'checking');
    INSERT INTO accounts (id, name, type) VALUES (${SAVINGS}, 'Savings', 'savings');
    INSERT INTO accounts (id, name, type) VALUES (${BROKERAGE}, 'Brokerage', 'tracking');
    INSERT INTO category_groups (id, name) VALUES (1, 'Spending');
    INSERT INTO categories (id, group_id, name) VALUES (${GROCERIES}, 1, 'Groceries');
  `);
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  seed();
});

afterEach(() => {
  sqlite.close();
});

describe("buildImportPreview", () => {
  it("matches a category by name (case-insensitive) and flags Ready to Assign as uncategorized", () => {
    const dbi = makeDb();
    const csv = parseImportCsv(
      Buffer.from(
        "Date,Payee,Category Group/Category,Memo,Outflow,Inflow\n" +
          "15.03.2025,Coop,Spending: groceries,,CHF 42.50,\n" +
          "16.03.2025,Employer,Inflow: Ready to Assign,,,CHF 5000.00\n"
      )
    );
    if (!csv.ok) throw new Error("expected parse to succeed");

    const preview = buildImportPreview(dbi, CHECKING, csv.rows);
    expect(preview).toHaveLength(2);
    expect(preview[0]).toMatchObject({ categoryId: GROCERIES, categoryName: "Groceries", status: "new" });
    expect(preview[1]).toMatchObject({ categoryId: null, categoryName: "Ready to Assign", status: "new" });
  });

  it("leaves an unmatched category name uncategorized (categoryId null) but shows it for display", () => {
    const dbi = makeDb();
    const csv = parseImportCsv(
      Buffer.from("Date,Payee,Category,Memo,Outflow,Inflow\n15.03.2025,Coop,Nonexistent,,CHF 42.50,\n")
    );
    if (!csv.ok) throw new Error("expected parse to succeed");

    const preview = buildImportPreview(dbi, CHECKING, csv.rows);
    expect(preview[0].categoryId).toBeNull();
    expect(preview[0].categoryName).toBe("Nonexistent");
  });

  it("flags a row as duplicate when an existing transaction matches (date, amount, payee)", () => {
    const dbi = makeDb();
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared) VALUES (${CHECKING}, '2025-03-15', 'Coop', -4250, 1)`
    );
    const csv = parseImportCsv(Buffer.from("Date,Payee,Memo,Outflow,Inflow\n15.03.2025,Coop,,CHF 42.50,\n"));
    if (!csv.ok) throw new Error("expected parse to succeed");

    const preview = buildImportPreview(dbi, CHECKING, csv.rows);
    expect(preview[0].status).toBe("duplicate");
  });

  it("flags a row as duplicate by import_hash even if the existing row's fields were later edited", () => {
    const dbi = makeDb();
    const hash = computeImportHash(CHECKING, "2025-03-15", -4250, "Coop");
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared, import_hash) VALUES (${CHECKING}, '2025-03-15', 'Coop (renamed)', -4250, 1, '${hash}')`
    );
    const csv = parseImportCsv(Buffer.from("Date,Payee,Memo,Outflow,Inflow\n15.03.2025,Coop,,CHF 42.50,\n"));
    if (!csv.ok) throw new Error("expected parse to succeed");

    const preview = buildImportPreview(dbi, CHECKING, csv.rows);
    expect(preview[0].status).toBe("duplicate");
  });

  it("does not flag a matching transaction in a different account", () => {
    const dbi = makeDb();
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared) VALUES (${SAVINGS}, '2025-03-15', 'Coop', -4250, 1)`
    );
    const csv = parseImportCsv(Buffer.from("Date,Payee,Memo,Outflow,Inflow\n15.03.2025,Coop,,CHF 42.50,\n"));
    if (!csv.ok) throw new Error("expected parse to succeed");

    const preview = buildImportPreview(dbi, CHECKING, csv.rows);
    expect(preview[0].status).toBe("new");
  });

  it("flags the second of two identical rows within the same file as a duplicate too", () => {
    const dbi = makeDb();
    const csv = parseImportCsv(
      Buffer.from(
        "Date,Payee,Memo,Outflow,Inflow\n15.03.2025,Coop,,CHF 42.50,\n15.03.2025,Coop,,CHF 42.50,\n"
      )
    );
    if (!csv.ok) throw new Error("expected parse to succeed");

    const preview = buildImportPreview(dbi, CHECKING, csv.rows);
    expect(preview[0].status).toBe("new");
    expect(preview[1].status).toBe("duplicate");
  });

  it("defaults new rows checked and duplicate rows unchecked is a UI concern — preview only reports status", () => {
    const dbi = makeDb();
    const csv = parseImportCsv(Buffer.from("Date,Payee,Memo,Outflow,Inflow\n15.03.2025,Coop,,CHF 42.50,\n"));
    if (!csv.ok) throw new Error("expected parse to succeed");
    const preview = buildImportPreview(dbi, CHECKING, csv.rows);
    expect(preview[0].status).toBe("new");
  });
});

describe("buildImportPreview — revised amounts", () => {
  /** Book one transaction and preview the same date/payee at `csvAmount` (in CHF). */
  function previewAgainst(existingRappen: number, csvOutflow: string, payee = "Auto Europe") {
    const dbi = makeDb();
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared) VALUES (${CHECKING}, '2026-08-02', '${payee}', ${existingRappen}, 1)`
    );
    const csv = parseImportCsv(
      Buffer.from(`Date,Payee,Memo,Outflow,Inflow\n02.08.2026,${payee},,CHF ${csvOutflow},\n`)
    );
    if (!csv.ok) throw new Error("expected parse to succeed");
    return buildImportPreview(dbi, CHECKING, csv.rows);
  }

  it("flags a rappen-level restatement as revised and points at the existing row", () => {
    const preview = previewAgainst(-32732, "327.30");
    expect(preview[0].status).toBe("revised");
    expect(preview[0].existingAmount).toBe(-32732);
    expect(preview[0].existingId).toBeGreaterThan(0);
  });

  it("revises a small amount when the drift is under 1% of it", () => {
    // 3.38 -> 3.40 is 0.6%, the shape of a restated foreign subscription.
    expect(previewAgainst(-338, "3.40")[0].status).toBe("revised");
  });

  it("leaves a drift above the 1% share as a new row", () => {
    // 1.90 -> 1.95 is 2.6%: far likelier a second purchase than a restatement.
    const preview = previewAgainst(-190, "1.95");
    expect(preview[0].status).toBe("new");
    expect(preview[0].existingId).toBeNull();
  });

  it("leaves a drift above the CHF 1.00 ceiling as a new row", () => {
    // 0.75% of 200.00, but 1.50 in absolute terms.
    expect(previewAgainst(-20000, "201.50")[0].status).toBe("new");
  });

  it("does not revise across a sign flip", () => {
    const dbi = makeDb();
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared) VALUES (${CHECKING}, '2026-08-02', 'Fust', 100, 1)`
    );
    const csv = parseImportCsv(Buffer.from("Date,Payee,Memo,Outflow,Inflow\n02.08.2026,Fust,,CHF 1.00,\n"));
    if (!csv.ok) throw new Error("expected parse to succeed");
    expect(buildImportPreview(dbi, CHECKING, csv.rows)[0].status).toBe("new");
  });

  it("stays out of it when two same-day charges from one merchant both fit", () => {
    const dbi = makeDb();
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared) VALUES
         (${CHECKING}, '2026-08-20', 'Felfel', -1290, 1),
         (${CHECKING}, '2026-08-20', 'Felfel', -1291, 1)`
    );
    const csv = parseImportCsv(Buffer.from("Date,Payee,Memo,Outflow,Inflow\n20.08.2026,Felfel,,CHF 12.92,\n"));
    if (!csv.ok) throw new Error("expected parse to succeed");
    expect(buildImportPreview(dbi, CHECKING, csv.rows)[0].status).toBe("new");
  });

  it("lets two CSV rows revise two different transactions, never the same one twice", () => {
    const dbi = makeDb();
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared) VALUES
         (${CHECKING}, '2026-08-01', 'Patreon', -338, 1),
         (${CHECKING}, '2026-08-01', 'Google Cloud', -333, 1)`
    );
    const csv = parseImportCsv(
      Buffer.from(
        "Date,Payee,Memo,Outflow,Inflow\n01.08.2026,Patreon,,CHF 3.40,\n01.08.2026,Google Cloud,,CHF 3.35,\n"
      )
    );
    if (!csv.ok) throw new Error("expected parse to succeed");
    const preview = buildImportPreview(dbi, CHECKING, csv.rows);
    expect(preview.map((r) => r.status)).toEqual(["revised", "revised"]);
    expect(preview[0].existingId).not.toBe(preview[1].existingId);
  });

  it("prefers duplicate over revised when the amount matches exactly", () => {
    expect(previewAgainst(-32732, "327.32")[0].status).toBe("duplicate");
  });

  it("does not offer a transaction an exact-duplicate row already matched", () => {
    const dbi = makeDb();
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared) VALUES (${CHECKING}, '2026-08-20', 'Felfel', -1290, 1)`
    );
    // The booked -12.90 is spent by the first row, leaving nothing for -12.91
    // to revise: the second charge is real and must import on its own.
    const csv = parseImportCsv(
      Buffer.from(
        "Date,Payee,Memo,Outflow,Inflow\n20.08.2026,Felfel,,CHF 12.90,\n20.08.2026,Felfel,,CHF 12.91,\n"
      )
    );
    if (!csv.ok) throw new Error("expected parse to succeed");
    const preview = buildImportPreview(dbi, CHECKING, csv.rows);
    expect(preview.map((r) => r.status)).toEqual(["duplicate", "new"]);
  });

  it("does not reach into another account", () => {
    const dbi = makeDb();
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared) VALUES (${SAVINGS}, '2026-08-02', 'Auto Europe', -32732, 1)`
    );
    const csv = parseImportCsv(
      Buffer.from("Date,Payee,Memo,Outflow,Inflow\n02.08.2026,Auto Europe,,CHF 327.30,\n")
    );
    if (!csv.ok) throw new Error("expected parse to succeed");
    expect(buildImportPreview(dbi, CHECKING, csv.rows)[0].status).toBe("new");
  });
});

describe("commitImport — revisions", () => {
  it("updates the amount and import_hash in place instead of inserting", () => {
    const dbi = makeDb();
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared) VALUES (${CHECKING}, '2026-08-02', 'Auto Europe', -32732, 1)`
    );
    const id = (sqlite.prepare("SELECT id FROM transactions").get() as { id: number }).id;
    const hash = computeImportHash(CHECKING, "2026-08-02", -32730, "Auto Europe");

    const count = commitImport(dbi, CHECKING, [], "batch-rev", [{ id, amount: -32730, importHash: hash }]);

    expect(count).toBe(1);
    const rows = sqlite.prepare("SELECT id, amount, import_hash FROM transactions").all();
    expect(rows).toEqual([{ id, amount: -32730, import_hash: hash }]);
  });

  it("mirrors the new amount onto the other leg of a transfer", () => {
    const dbi = makeDb();
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared, transfer_account_id, transfer_pair_id) VALUES
         (${CHECKING}, '2026-08-02', 'Transfer', -5000, 1, ${SAVINGS}, 'pair-1'),
         (${SAVINGS}, '2026-08-02', 'Transfer', 5000, 1, ${CHECKING}, 'pair-1')`
    );
    const id = (
      sqlite.prepare(`SELECT id FROM transactions WHERE account_id = ${CHECKING}`).get() as { id: number }
    ).id;

    commitImport(dbi, CHECKING, [], "batch-rev-transfer", [
      { id, amount: -5010, importHash: computeImportHash(CHECKING, "2026-08-02", -5010, "Transfer") },
    ]);

    const amounts = (
      sqlite.prepare("SELECT account_id, amount FROM transactions ORDER BY account_id").all() as Array<{
        account_id: number;
        amount: number;
      }>
    ).map((r) => [r.account_id, r.amount]);
    expect(amounts).toEqual([
      [CHECKING, -5010],
      [SAVINGS, 5010],
    ]);
  });

  it("counts revisions alongside inserts and stays idempotent per batch", () => {
    const dbi = makeDb();
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared) VALUES (${CHECKING}, '2026-08-02', 'Auto Europe', -32732, 1)`
    );
    const id = (sqlite.prepare("SELECT id FROM transactions").get() as { id: number }).id;
    const args = [
      dbi,
      CHECKING,
      [
        {
          date: "2026-08-03",
          payee: "SBB",
          memo: "",
          amount: -80000,
          categoryId: null,
          importHash: computeImportHash(CHECKING, "2026-08-03", -80000, "SBB"),
        },
      ],
      "batch-mixed",
      [{ id, amount: -32730, importHash: computeImportHash(CHECKING, "2026-08-02", -32730, "Auto Europe") }],
    ] satisfies Parameters<typeof commitImport>;

    expect(commitImport(...args)).toBe(2);
    expect(commitImport(...args)).toBe(2); // replay: no second insert, no second update
    expect(sqlite.prepare("SELECT COUNT(*) c FROM transactions").get()).toEqual({ c: 2 });
  });

  it("skips a target deleted between preview and confirm", () => {
    const dbi = makeDb();
    const count = commitImport(dbi, CHECKING, [], "batch-gone", [
      { id: 9999, amount: -100, importHash: "stale" },
    ]);
    expect(count).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) c FROM transactions").get()).toEqual({ c: 0 });
  });
});

describe("commitImport", () => {
  it("inserts the given rows with import_hash set and uncategorized when categoryId is null", () => {
    const dbi = makeDb();
    const hash = computeImportHash(CHECKING, "2025-03-15", -4250, "Coop");
    const count = commitImport(
      dbi,
      CHECKING,
      [{ date: "2025-03-15", payee: "Coop", memo: "", amount: -4250, categoryId: null, importHash: hash }],
      "batch-1"
    );
    expect(count).toBe(1);

    const rows = sqlite.prepare("SELECT * FROM transactions").all() as Array<{
      account_id: number;
      date: string;
      payee: string;
      category_id: number | null;
      amount: number;
      cleared: number;
      import_hash: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: CHECKING,
      date: "2025-03-15",
      payee: "Coop",
      category_id: null,
      amount: -4250,
      cleared: 1,
      import_hash: hash,
    });
  });

  it("inserts a matched category id when provided", () => {
    const dbi = makeDb();
    commitImport(
      dbi,
      CHECKING,
      [
        {
          date: "2025-03-15",
          payee: "Coop",
          memo: "",
          amount: -4250,
          categoryId: GROCERIES,
          importHash: "h1",
        },
      ],
      "batch-1"
    );
    const row = sqlite.prepare("SELECT category_id FROM transactions").get() as { category_id: number };
    expect(row.category_id).toBe(GROCERIES);
  });

  it("does nothing for an empty row list", () => {
    const dbi = makeDb();
    const count = commitImport(dbi, CHECKING, [], "batch-1");
    expect(count).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) as c FROM transactions").get()).toEqual({ c: 0 });
  });

  it("is idempotent: two commits with the same batchId insert once and both return the original count", () => {
    const dbi = makeDb();
    const rows = [
      { date: "2025-03-15", payee: "Coop", memo: "", amount: -4250, categoryId: null, importHash: "h1" },
      { date: "2025-03-16", payee: "Migros", memo: "", amount: -1000, categoryId: null, importHash: "h2" },
    ];

    const first = commitImport(dbi, CHECKING, rows, "retry-batch");
    expect(first).toBe(2);

    // Simulate a retried/resubmitted server action with the exact same rows
    // and batchId (e.g. the client never saw the first response).
    const second = commitImport(dbi, CHECKING, rows, "retry-batch");
    expect(second).toBe(2);

    const total = sqlite.prepare("SELECT COUNT(*) as c FROM transactions").get() as { c: number };
    expect(total.c).toBe(2); // not 4 — the retry didn't re-insert
  });

  it("a different batchId with the same content still commits (not a content-based dedupe)", () => {
    const dbi = makeDb();
    const rows = [{ date: "2025-03-15", payee: "Coop", memo: "", amount: -4250, categoryId: null, importHash: "h1" }];

    commitImport(dbi, CHECKING, rows, "batch-a");
    commitImport(dbi, CHECKING, rows, "batch-b");

    // Legitimate case: the user genuinely re-runs an import with an
    // overlapping row (e.g. a duplicate they intentionally kept checked).
    // Only same-batchId retries are deduped, not identical content.
    const total = sqlite.prepare("SELECT COUNT(*) as c FROM transactions").get() as { c: number };
    expect(total.c).toBe(2);
  });

  it("a full round trip (preview -> commit checked rows) leaves duplicates out when unchecked", () => {
    const dbi = makeDb();
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared) VALUES (${CHECKING}, '2025-03-15', 'Coop', -4250, 1)`
    );
    const csv = parseImportCsv(
      Buffer.from(
        "Date,Payee,Memo,Outflow,Inflow\n" +
          "15.03.2025,Coop,,CHF 42.50,\n" + // duplicate of the seeded row
          "16.03.2025,Migros,,CHF 10.00,\n" // new
      )
    );
    if (!csv.ok) throw new Error("expected parse to succeed");
    const preview = buildImportPreview(dbi, CHECKING, csv.rows);

    // Simulate the UI default: new rows checked, duplicates unchecked.
    const checked = preview.filter((r) => r.status !== "duplicate");
    const inserted = commitImport(
      dbi,
      CHECKING,
      checked.map((r) => ({
        date: r.date,
        payee: r.payee,
        memo: r.memo,
        amount: r.amount,
        categoryId: r.categoryId,
        importHash: r.importHash,
        transferAccountId: r.transferAccountId,
      })),
      "batch-1"
    );
    expect(inserted).toBe(1);

    const total = sqlite.prepare("SELECT COUNT(*) as c FROM transactions").get() as { c: number };
    expect(total.c).toBe(2); // seeded row + the one new import
  });
});

describe("importing transfers", () => {
  function previewOf(csv: string, accountId = CHECKING) {
    const parsed = parseImportCsv(Buffer.from(csv));
    if (!parsed.ok) throw new Error(`expected parse to succeed: ${JSON.stringify(parsed.errors)}`);
    return { preview: buildImportPreview(makeDb(), accountId, parsed.rows) };
  }

  it("resolves the counterpart account case-insensitively and stores the row as a Transfer", () => {
    const { preview } = previewOf("Date,Payee,Memo,Outflow,Inflow,Transfer\n21.07.2026,Cardco,,CHF 100.00,,savings\n");
    expect(preview[0]).toMatchObject({
      transferAccountId: SAVINGS,
      transferAccountName: "Savings",
      // Payee becomes "Transfer" (app convention); the CSV's payee moves to memo.
      payee: "Transfer",
      memo: "Cardco",
      amount: -10000,
    });
  });

  it("keeps an explicit memo and does not overwrite it with the payee", () => {
    const { preview } = previewOf(
      "Date,Payee,Memo,Outflow,Inflow,Transfer\n21.07.2026,Cardco,Card bill,CHF 100.00,,Savings\n"
    );
    expect(preview[0].memo).toBe("Card bill");
  });

  it("commits both legs, linked by transferPairId, with the hash only on the imported leg", () => {
    const dbi = makeDb();
    const parsed = parseImportCsv(
      Buffer.from("Date,Payee,Memo,Outflow,Inflow,Transfer\n21.07.2026,Cardco,,CHF 100.00,,Savings\n")
    );
    if (!parsed.ok) throw new Error("expected parse to succeed");
    const preview = buildImportPreview(dbi, CHECKING, parsed.rows);
    const count = commitImport(dbi, CHECKING, preview, "batch-t");

    expect(count).toBe(1); // one CSV row...
    const legs = sqlite
      .prepare(
        "SELECT account_id, amount, payee, transfer_account_id, transfer_pair_id, import_hash FROM transactions ORDER BY account_id"
      )
      .all() as Array<{
      account_id: number;
      amount: number;
      payee: string;
      transfer_account_id: number;
      transfer_pair_id: string;
      import_hash: string | null;
    }>;
    expect(legs).toHaveLength(2); // ...two transactions
    expect(legs[0]).toMatchObject({
      account_id: CHECKING,
      amount: -10000,
      transfer_account_id: SAVINGS,
      payee: "Transfer",
    });
    expect(legs[1]).toMatchObject({
      account_id: SAVINGS,
      amount: 10000,
      transfer_account_id: CHECKING,
      import_hash: null,
    });
    expect(legs[0].transfer_pair_id).toBe(legs[1].transfer_pair_id);
    expect(legs[0].import_hash).not.toBeNull();
  });

  it("flags a transfer already entered by hand as a duplicate, despite no import_hash", () => {
    const dbi = makeDb();
    // How createTransfer writes it: payee "Transfer", no import_hash.
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared, transfer_account_id)
       VALUES (${CHECKING}, '2026-07-21', 'Transfer', -10000, 1, ${SAVINGS})`
    );
    const parsed = parseImportCsv(
      Buffer.from("Date,Payee,Memo,Outflow,Inflow,Transfer\n21.07.2026,Card Services AG,,CHF 100.00,,Savings\n")
    );
    if (!parsed.ok) throw new Error("expected parse to succeed");
    expect(buildImportPreview(dbi, CHECKING, parsed.rows)[0].status).toBe("duplicate");
  });

  it("applies a category only to the on-budget leg when the other side is tracking", () => {
    const dbi = makeDb();
    const parsed = parseImportCsv(
      Buffer.from("Date,Payee,Memo,Outflow,Inflow,Category,Transfer\n21.07.2026,Buy,,CHF 100.00,,Groceries,Brokerage\n")
    );
    if (!parsed.ok) throw new Error("expected parse to succeed");
    commitImport(dbi, CHECKING, buildImportPreview(dbi, CHECKING, parsed.rows), "batch-tr");

    const legs = sqlite
      .prepare("SELECT account_id, category_id FROM transactions ORDER BY account_id")
      .all() as Array<{ account_id: number; category_id: number | null }>;
    expect(legs).toEqual([
      { account_id: CHECKING, category_id: GROCERIES },
      { account_id: BROKERAGE, category_id: null },
    ]);
  });

  it("drops the category on a transfer between two on-budget accounts", () => {
    const dbi = makeDb();
    const parsed = parseImportCsv(
      Buffer.from("Date,Payee,Memo,Outflow,Inflow,Category,Transfer\n21.07.2026,Move,,CHF 100.00,,Groceries,Savings\n")
    );
    if (!parsed.ok) throw new Error("expected parse to succeed");
    commitImport(dbi, CHECKING, buildImportPreview(dbi, CHECKING, parsed.rows), "batch-on");

    const cats = sqlite.prepare("SELECT category_id FROM transactions").all() as Array<{ category_id: number | null }>;
    expect(cats).toEqual([{ category_id: null }, { category_id: null }]);
  });
});

describe("findTransferAccountErrors", () => {
  function rowsOf(csv: string) {
    const parsed = parseImportCsv(Buffer.from(csv));
    if (!parsed.ok) throw new Error("expected parse to succeed");
    return parsed.rows;
  }

  it("rejects an unknown counterpart account rather than importing it as spending", () => {
    const dbi = makeDb();
    const rows = rowsOf("Date,Payee,Memo,Outflow,Inflow,Transfer\n21.07.2026,Cardco,,CHF 100.00,,Nope\n");
    expect(findTransferAccountErrors(dbi, CHECKING, rows)).toEqual([
      { line: 2, message: 'Unknown transfer account "Nope".' },
    ]);
  });

  it("rejects a transfer pointing at the account being imported into", () => {
    const dbi = makeDb();
    const rows = rowsOf("Date,Payee,Memo,Outflow,Inflow,Transfer\n21.07.2026,Cardco,,CHF 100.00,,Checking\n");
    expect(findTransferAccountErrors(dbi, CHECKING, rows)).toEqual([
      { line: 2, message: 'Transfer account "Checking" is this account.' },
    ]);
  });

  it("returns nothing for a file with no Transfer column", () => {
    const dbi = makeDb();
    const rows = rowsOf("Date,Payee,Memo,Outflow,Inflow\n21.07.2026,Coop,,CHF 42.50,\n");
    expect(findTransferAccountErrors(dbi, CHECKING, rows)).toEqual([]);
  });
});

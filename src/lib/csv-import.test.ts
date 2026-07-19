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
import { buildImportPreview, commitImport } from "./queries";

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
  icon TEXT
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
  hidden INTEGER NOT NULL DEFAULT 0,
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
const GROCERIES = 10;

function seed() {
  sqlite.exec(DDL);
  sqlite.exec(`
    INSERT INTO accounts (id, name, type) VALUES (${CHECKING}, 'Checking', 'checking');
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
    expect(preview[0]).toMatchObject({ categoryId: GROCERIES, categoryName: "Groceries", isDuplicate: false });
    expect(preview[1]).toMatchObject({ categoryId: null, categoryName: "Ready to Assign", isDuplicate: false });
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
    expect(preview[0].isDuplicate).toBe(true);
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
    expect(preview[0].isDuplicate).toBe(true);
  });

  it("does not flag a matching transaction in a different account", () => {
    const dbi = makeDb();
    sqlite.exec(`INSERT INTO accounts (id, name, type) VALUES (2, 'Savings', 'savings')`);
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared) VALUES (2, '2025-03-15', 'Coop', -4250, 1)`
    );
    const csv = parseImportCsv(Buffer.from("Date,Payee,Memo,Outflow,Inflow\n15.03.2025,Coop,,CHF 42.50,\n"));
    if (!csv.ok) throw new Error("expected parse to succeed");

    const preview = buildImportPreview(dbi, CHECKING, csv.rows);
    expect(preview[0].isDuplicate).toBe(false);
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
    expect(preview[0].isDuplicate).toBe(false);
    expect(preview[1].isDuplicate).toBe(true);
  });

  it("defaults new rows checked and duplicate rows unchecked is a UI concern — preview only reports isDuplicate", () => {
    const dbi = makeDb();
    const csv = parseImportCsv(Buffer.from("Date,Payee,Memo,Outflow,Inflow\n15.03.2025,Coop,,CHF 42.50,\n"));
    if (!csv.ok) throw new Error("expected parse to succeed");
    const preview = buildImportPreview(dbi, CHECKING, csv.rows);
    expect(preview[0].isDuplicate).toBe(false);
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
    const checked = preview.filter((r) => !r.isDuplicate);
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
      })),
      "batch-1"
    );
    expect(inserted).toBe(1);

    const total = sqlite.prepare("SELECT COUNT(*) as c FROM transactions").get() as { c: number };
    expect(total.c).toBe(2); // seeded row + the one new import
  });
});

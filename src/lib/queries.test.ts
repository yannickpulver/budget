import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { loadBudgetData, SnapshotStore } from "./queries";
import type { MonthSnapshot } from "./budget-math";

/**
 * Integration test for the caching query layer. Uses a throwaway in-memory
 * SQLite fixture (never the real data/budget.db) and proves the incremental
 * snapshot cache returns the same numbers as a fresh compute, before and after
 * an invalidating write.
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
`;

const GROCERIES = 1;
const RENT = 2;

function seed() {
  sqlite.exec(DDL);
  sqlite.exec(`
    INSERT INTO accounts (id, name, type) VALUES (1, 'Checking', 'checking');
    INSERT INTO category_groups (id, name, sort, hidden) VALUES (10, 'Spending', 0, 0);
    INSERT INTO categories (id, group_id, name, sort) VALUES
      (${GROCERIES}, 10, 'Groceries', 0),
      (${RENT}, 10, 'Rent', 1);
    -- Jan: income + assignments + spending.
    INSERT INTO transactions (account_id, date, category_id, amount) VALUES
      (1, '2025-01-05', NULL, 500000),
      (1, '2025-01-10', ${GROCERIES}, -8000),
      (1, '2025-01-12', ${RENT}, -150000);
    INSERT INTO assignments (month, category_id, amount) VALUES
      ('2025-01', ${GROCERIES}, 20000),
      ('2025-01', ${RENT}, 150000);
    -- Feb: more grocery spend, no new assignment.
    INSERT INTO transactions (account_id, date, category_id, amount) VALUES
      (1, '2025-02-08', ${GROCERIES}, -5000);
  `);
}

function normalize(snapshot: MonthSnapshot) {
  return {
    readyToAssign: snapshot.readyToAssign,
    cumulativeOnBudgetFunds: snapshot.cumulativeOnBudgetFunds,
    categories: Array.from(snapshot.categories.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([id, cell]) => [id, cell.assigned, cell.activity, cell.available]),
  };
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  seed();
});

afterEach(() => {
  sqlite.close();
});

describe("SnapshotStore", () => {
  const loader = () => loadBudgetData(makeDb());

  it("caches a month and matches a fresh compute", () => {
    const store = new SnapshotStore(loader);
    const cached1 = store.getSnapshot("2025-02");
    const cached2 = store.getSnapshot("2025-02");
    // Second call hits the cache — same object reference.
    expect(cached2).toBe(cached1);

    const fresh = new SnapshotStore(loader).getSnapshot("2025-02");
    expect(normalize(cached1)).toEqual(normalize(fresh));

    // Feb Groceries: Jan available (20000 - 8000 = 12000) carried, minus 5000.
    expect(cached1.categories.get(GROCERIES)?.available).toBe(7000);
  });

  it("walks forward incrementally without recomputing cached months", () => {
    const store = new SnapshotStore(loader);
    const jan = store.getSnapshot("2025-01");
    const feb = store.getSnapshot("2025-02");
    // Requesting Jan again returns the same memoized object.
    expect(store.getSnapshot("2025-01")).toBe(jan);
    expect(feb.categories.get(GROCERIES)?.available).toBe(7000);
  });

  it("reflects writes only after invalidation, still matching a fresh compute", () => {
    const store = new SnapshotStore(loader);
    const before = store.getSnapshot("2025-02");
    expect(before.categories.get(GROCERIES)?.available).toBe(7000);

    // Assign another 100.00 to Groceries in February.
    sqlite
      .prepare("INSERT INTO assignments (month, category_id, amount) VALUES (?, ?, ?)")
      .run("2025-02", GROCERIES, 10000);

    // Stale cache still returns the old number.
    expect(store.getSnapshot("2025-02")).toBe(before);

    store.invalidate();
    const after = store.getSnapshot("2025-02");
    expect(after.categories.get(GROCERIES)?.available).toBe(17000);

    const fresh = new SnapshotStore(loader).getSnapshot("2025-02");
    expect(normalize(after)).toEqual(normalize(fresh));
  });
});

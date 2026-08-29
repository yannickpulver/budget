import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import {
  assignedAfterMonth,
  categoryMatchesFilter,
  computeAlignmentAdjustment,
  countBudgetFilterMatches,
  filterGroupViews,
  getCategoryStats,
  getSidebarData,
  listAccounts,
  loadBudgetData,
  reorderAccounts,
  SnapshotStore,
  type CategoryView,
  type GroupView,
} from "./queries";
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
  monthly_target INTEGER,
  target_type TEXT NOT NULL DEFAULT 'monthly',
  target_date TEXT
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
`;

const GROCERIES = 1;
const RENT = 2;
const SAVING = 3;

function seed() {
  sqlite.exec(DDL);
  sqlite.exec(`
    INSERT INTO accounts (id, name, type) VALUES (1, 'Checking', 'checking');
    INSERT INTO category_groups (id, name, sort, hidden) VALUES (10, 'Spending', 0, 0);
    INSERT INTO categories (id, group_id, name, sort) VALUES
      (${GROCERIES}, 10, 'Groceries', 0),
      (${RENT}, 10, 'Rent', 1),
      (${SAVING}, 10, 'Brokerage', 2);
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

describe("RTA alignment adjustment", () => {
  const loader = () => loadBudgetData(makeDb());

  function setAdjustment(amount: number, month: string) {
    sqlite
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("rta_adjustment", String(amount));
    sqlite
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run("rta_adjustment_month", month);
  }

  it("applies from its month onward, not before", () => {
    const raw = new SnapshotStore(loader);
    const rawJan = raw.getSnapshot("2025-01").readyToAssign;
    const rawFeb = raw.getSnapshot("2025-02").readyToAssign;

    setAdjustment(10000, "2025-02");
    const store = new SnapshotStore(loader);
    // January is before the adjustment month — untouched.
    expect(store.getSnapshot("2025-01").readyToAssign).toBe(rawJan);
    // February and onward carry the flat offset.
    expect(store.getSnapshot("2025-02").readyToAssign).toBe(rawFeb + 10000);
  });

  it("persists as a constant offset across later months with no clamp bounce", () => {
    const raw = new SnapshotStore(loader);
    const rawFeb = raw.getSnapshot("2025-02").readyToAssign;
    // March has no transactions/assignments — a pure carry-forward month.
    const rawMar = raw.getSnapshot("2025-03").readyToAssign;

    setAdjustment(-2500, "2025-02");
    const store = new SnapshotStore(loader);
    // The offset is identical every month it applies — it never compounds or
    // bounces off the overspend clamp because it's added to RTA only, on top
    // of a clean carried cumulative-funds state.
    expect(store.getSnapshot("2025-02").readyToAssign - rawFeb).toBe(-2500);
    expect(store.getSnapshot("2025-03").readyToAssign - rawMar).toBe(-2500);
  });

  it("never touches category availables or the carried funds state", () => {
    const raw = normalize(new SnapshotStore(loader).getSnapshot("2025-02"));

    setAdjustment(99999, "2025-01");
    const adjusted = new SnapshotStore(loader).getSnapshot("2025-02");
    // Only readyToAssign moves; every category cell and the cumulative funds
    // carry are byte-for-byte identical.
    expect(adjusted.cumulativeOnBudgetFunds).toBe(raw.cumulativeOnBudgetFunds);
    expect(
      Array.from(adjusted.categories.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([id, cell]) => [id, cell.assigned, cell.activity, cell.available])
    ).toEqual(raw.categories);
  });

  it("reflects a changed adjustment only after cache invalidation", () => {
    setAdjustment(10000, "2025-01");
    const store = new SnapshotStore(loader);
    const before = store.getSnapshot("2025-02");
    const baseline = before.readyToAssign;

    // Change the stored adjustment out from under the cache.
    setAdjustment(30000, "2025-01");
    expect(store.getSnapshot("2025-02")).toBe(before); // stale

    store.invalidate();
    expect(store.getSnapshot("2025-02").readyToAssign).toBe(baseline + 20000);
  });

  it("computeAlignmentAdjustment snaps raw RTA to target and is idempotent", () => {
    // No existing adjustment: delta is target − current.
    expect(computeAlignmentAdjustment(32895, -225346, 0)).toBe(258241);
    // Re-aligning with an adjustment already applied recovers the raw RTA
    // first, so the result is the same, not compounded.
    expect(computeAlignmentAdjustment(32895, 32895, 258241)).toBe(258241);
    // Aligning to a new target with an existing adjustment in place.
    expect(computeAlignmentAdjustment(50000, 32895, 258241)).toBe(275346);
  });
});

describe("SnapshotStore data_version guard", () => {
  // Unlike the ":memory:" fixture above, this needs a real file on disk so a
  // *second* connection can open it alongside the store's own connection —
  // reproducing e.g. `pnpm migrate:ynab` writing to the same DB file while
  // the server (holding the first connection) is still running.
  let tmpDir: string;
  let dbPath: string;
  let ownConn: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-data-version-"));
    dbPath = path.join(tmpDir, "scratch.db");
    ownConn = new Database(dbPath);
    ownConn.exec(DDL);
    ownConn.exec(`
      INSERT INTO accounts (id, name, type) VALUES (1, 'Checking', 'checking');
      INSERT INTO category_groups (id, name, sort, hidden) VALUES (10, 'Spending', 0, 0);
      INSERT INTO categories (id, group_id, name, sort) VALUES (${GROCERIES}, 10, 'Groceries', 0);
      INSERT INTO transactions (account_id, date, category_id, amount) VALUES
        (1, '2025-01-05', NULL, 500000),
        (1, '2025-01-10', ${GROCERIES}, -8000);
      INSERT INTO assignments (month, category_id, amount) VALUES ('2025-01', ${GROCERIES}, 20000);
    `);
  });

  afterEach(() => {
    ownConn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("picks up a write from a different connection without an explicit invalidate()", () => {
    const store = new SnapshotStore(
      () => loadBudgetData(drizzle(ownConn, { schema })),
      () => ownConn.pragma("data_version", { simple: true }) as number
    );

    const before = store.getSnapshot("2025-01");
    expect(before.categories.get(GROCERIES)?.available).toBe(12000); // 20000 - 8000

    // A second process opens its own connection to the same file and
    // commits a write — the store's own connection never touched it, so
    // this exercises exactly the "other process" scenario.
    const otherConn = new Database(dbPath);
    otherConn.prepare("UPDATE assignments SET amount = amount + ? WHERE month = ? AND category_id = ?").run(
      10000,
      "2025-01",
      GROCERIES
    );
    otherConn.close();

    // No store.invalidate() call — the data_version check must catch it.
    const after = store.getSnapshot("2025-01");
    expect(after).not.toBe(before);
    expect(after.categories.get(GROCERIES)?.available).toBe(22000); // 30000 - 8000

    const fresh = new SnapshotStore(() => loadBudgetData(drizzle(ownConn, { schema }))).getSnapshot("2025-01");
    expect(normalize(after)).toEqual(normalize(fresh));
  });

  it("does not thrash the cache when nothing external has changed", () => {
    const store = new SnapshotStore(
      () => loadBudgetData(drizzle(ownConn, { schema })),
      () => ownConn.pragma("data_version", { simple: true }) as number
    );

    const first = store.getSnapshot("2025-01");
    const second = store.getSnapshot("2025-01");
    expect(second).toBe(first);
  });
});

describe("reorderAccounts", () => {
  it("reindexes sort to match the given order, for only the passed ids", () => {
    const dbi = makeDb();
    // Account 1 ('Checking') already exists from the shared seed at sort 0.
    sqlite.exec(`
      INSERT INTO accounts (id, name, type, sort) VALUES
        (2, 'Savings', 'savings', 1),
        (3, 'Cash', 'cash', 2);
    `);
    expect(listAccounts(dbi).map((a) => a.id)).toEqual([1, 2, 3]);

    reorderAccounts(dbi, [3, 1, 2]);

    expect(listAccounts(dbi).map((a) => a.id)).toEqual([3, 1, 2]);
  });

  it("is reflected in getSidebarData's section ordering", () => {
    const dbi = makeDb();
    sqlite.exec(`INSERT INTO accounts (id, name, type, sort) VALUES (2, 'Savings', 'savings', 1);`);

    reorderAccounts(dbi, [2, 1]);

    expect(getSidebarData(dbi).budget.map((a) => a.id)).toEqual([2, 1]);
  });
});

describe("budget filter chips", () => {
  function cat(overrides: Partial<CategoryView> & { id: number; name: string }): CategoryView {
    return {
      assigned: 0,
      activity: 0,
      available: 0,
      monthlyTarget: null,
      targetType: "monthly",
      targetDate: null,
      goal: null,
      underfunded: false,
      goalFunded: false,
      activityTransactions: [],
      avgSpend: null,
      ...overrides,
    };
  }

  const funded = cat({ id: 1, name: "Funded", monthlyTarget: 10000, assigned: 10000, goal: { met: true, remaining: 0 } });
  const underfunded = cat({
    id: 2,
    name: "Underfunded",
    monthlyTarget: 10000,
    assigned: 4000,
    goal: { met: false, remaining: 6000 },
    underfunded: true,
  });
  const negative = cat({ id: 3, name: "Negative", available: -500 });
  const both = cat({
    id: 4,
    name: "Both",
    monthlyTarget: 5000,
    assigned: 0,
    goal: { met: false, remaining: 5000 },
    underfunded: true,
    available: -200,
  });
  const plain = cat({ id: 5, name: "Plain" });

  const groups: GroupView[] = [
    { id: 100, name: "Spending", categories: [funded, underfunded, negative] },
    { id: 200, name: "Saving", categories: [both, plain] },
  ];

  describe("categoryMatchesFilter", () => {
    it("'underfunded' matches a category with an unmet monthly target", () => {
      expect(categoryMatchesFilter(underfunded, "underfunded")).toBe(true);
      expect(categoryMatchesFilter(funded, "underfunded")).toBe(false);
      expect(categoryMatchesFilter(plain, "underfunded")).toBe(false);
    });

    it("'negative' matches a category with available < 0", () => {
      expect(categoryMatchesFilter(negative, "negative")).toBe(true);
      expect(categoryMatchesFilter(funded, "negative")).toBe(false);
    });
  });

  describe("countBudgetFilterMatches", () => {
    it("counts matches across all groups", () => {
      expect(countBudgetFilterMatches(groups, "underfunded")).toBe(2); // underfunded, both
      expect(countBudgetFilterMatches(groups, "negative")).toBe(2); // negative, both
    });
  });

  describe("filterGroupViews", () => {
    it("returns groups unchanged when no filters are active", () => {
      expect(filterGroupViews(groups, [])).toBe(groups);
    });

    it("keeps only matching categories and drops now-empty groups", () => {
      const result = filterGroupViews(groups, ["negative"]);
      expect(result.map((g) => ({ id: g.id, categoryIds: g.categories.map((c) => c.id) }))).toEqual([
        { id: 100, categoryIds: [3] },
        { id: 200, categoryIds: [4] },
      ]);
    });

    it("unions multiple active filters", () => {
      const result = filterGroupViews(groups, ["underfunded", "negative"]);
      const ids = result.flatMap((g) => g.categories.map((c) => c.id));
      expect(ids.sort()).toEqual([2, 3, 4]);
    });

    it("drops a group entirely when none of its categories match", () => {
      const result = filterGroupViews(
        [{ id: 999, name: "All funded", categories: [funded] }],
        ["underfunded"]
      );
      expect(result).toEqual([]);
    });
  });
});

describe("assignedAfterMonth", () => {
  const totals = new Map([
    ["2026-06", 900_00],
    ["2026-07", 500_00],
    ["2026-08", 600_00],
    ["2026-09", 250_00],
  ]);

  it("sums only the months strictly after the given one", () => {
    expect(assignedAfterMonth(totals, "2026-07")).toBe(850_00);
    expect(assignedAfterMonth(totals, "2026-08")).toBe(250_00);
    expect(assignedAfterMonth(totals, "2026-09")).toBe(0);
  });

  it("applies to a past month too, so RTA doesn't reappear when browsing back", () => {
    // Viewing June must still subtract July-September; otherwise navigating
    // back to a past month would make already-assigned money look available
    // again.
    expect(assignedAfterMonth(totals, "2026-06")).toBe(1350_00);
  });

  it("is zero when nothing is budgeted ahead", () => {
    expect(assignedAfterMonth(new Map(), "2026-07")).toBe(0);
  });
});

describe("getCategoryStats", () => {
  // Fixture activity for GROCERIES: -8000 in 2025-01, -5000 in 2025-02.
  // `monthsElapsed` drives the per-month average, so these tests pin its
  // three cases: a past year spans its own 12 months (not through today), the
  // current year stops at the current month, and a month period is always 1.

  it("averages a past year over that year's own 12 months, not through today", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    const stats = getCategoryStats(GROCERIES, "2025", makeDb(), now);

    expect(stats.totalOutflow).toBe(13000);
    expect(stats.monthsElapsed).toBe(12);
    expect(stats.avgOutflowPerMonth).toBe(Math.round(13000 / 12));
  });

  it("stops the current year's average at the current month", () => {
    const now = new Date("2025-06-15T00:00:00Z");
    const stats = getCategoryStats(GROCERIES, "2025", makeDb(), now);

    // Jan through June inclusive = 6 months, even though activity stops in Feb.
    expect(stats.monthsElapsed).toBe(6);
    expect(stats.avgOutflowPerMonth).toBe(Math.round(13000 / 6));
  });

  it("treats a month period as 1 elapsed month", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    const stats = getCategoryStats(GROCERIES, "2025-01", makeDb(), now);

    expect(stats.monthsElapsed).toBe(1);
    expect(stats.totalOutflow).toBe(8000);
    expect(stats.avgOutflowPerMonth).toBe(8000);
  });

  it("spans all-time from the category's first active month through the current month", () => {
    const now = new Date("2025-06-15T00:00:00Z");
    const stats = getCategoryStats(GROCERIES, "all", makeDb(), now);

    // First active month is 2025-01; capped at the current month, 2025-06.
    expect(stats.monthsElapsed).toBe(6);
    expect(stats.totalOutflow).toBe(13000);
    expect(stats.avgOutflowPerMonth).toBe(Math.round(13000 / 6));
  });

  // Fix 1: the Categories tab's all-categories aggregate must reconcile with
  // Overview's spending total, which excludes transfers entirely -- including
  // a categorized transfer leg like "Transfer to Brokerage" filed under a
  // Saving/Investing category. A single-category drill-down, however, is a
  // ledger view of that one category and must keep showing the leg.
  it("excludes a categorized transfer leg from the all-categories aggregate", () => {
    sqlite.exec(`
      INSERT INTO accounts (id, name, type) VALUES (99, 'Brokerage', 'tracking');
      -- A categorized transfer leg to a tracking account (e.g. "Transfer to
      -- Brokerage" filed under Saving/Investing) -- moving money, not spending.
      INSERT INTO transactions (account_id, date, category_id, amount, transfer_account_id) VALUES
        (1, '2025-02-15', ${SAVING}, -30000, 99);
    `);
    const now = new Date("2025-06-15T00:00:00Z");
    const stats = getCategoryStats(null, "2025-02", makeDb(), now);

    // Groceries 5000 only; the -30000 transfer leg (categorized SAVING) is excluded.
    expect(stats.totalOutflow).toBe(5000);
  });

  it("includes that same transfer leg when drilling into its specific category", () => {
    sqlite.exec(`
      INSERT INTO accounts (id, name, type) VALUES (99, 'Brokerage', 'tracking');
      INSERT INTO transactions (account_id, date, category_id, amount, transfer_account_id) VALUES
        (1, '2025-02-15', ${SAVING}, -30000, 99);
    `);
    const now = new Date("2025-06-15T00:00:00Z");
    const stats = getCategoryStats(SAVING, "2025-02", makeDb(), now);

    expect(stats.totalOutflow).toBe(30000);
  });
});

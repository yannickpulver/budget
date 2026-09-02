import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import {
  CHRONIC_OVER_MIN_HITS,
  CHRONIC_UNDER_MIN_HITS,
  getAssignedVsSpent,
  getChronicCategories,
} from "./stats-budget-queries";

/**
 * Integration tests for the envelope report. Uses the same throwaway
 * in-memory SQLite fixture pattern as stats-queries.test.ts.
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
`;

const GROCERIES = 1;
const RENT = 2;
const CC_PAYMENT = 3;
const ENTERTAINMENT = 4;
const OLD_GYM = 5; // hidden from 2026-01 — hidden for the whole April period.
const SUBSCRIPTIONS = 6; // hidden from 2026-04 — hidden for a one-month April period, but only at the END of the 2026 year period.
const UNUSED = 7; // sole member of a group with no assignments and no spend.
const SECRET = 8; // sits in a hidden group — the budget page doesn't show it at all.

const NOW = new Date("2026-04-15T12:00:00Z");

function baseSchema() {
  sqlite.exec(DDL);
  sqlite.exec(`
    INSERT INTO accounts (id, name, type, payment_category_id) VALUES
      (1, 'Checking', 'checking', NULL),
      (2, 'Savings', 'savings', NULL),
      (3, 'Credit', 'credit', ${CC_PAYMENT}),
      (4, 'Tracking', 'tracking', NULL);

    INSERT INTO category_groups (id, name, sort, hidden) VALUES
      (10, '1. Spending', 1, 0),
      (20, '2. Fun', 2, 0),
      (30, 'Archive', 3, 0),
      (40, 'Empty', 4, 0),
      (50, 'Hidden Group', 5, 1);

    INSERT INTO categories (id, group_id, name, sort, hidden_from) VALUES
      (${GROCERIES}, 10, 'Groceries', 0, NULL),
      (${RENT}, 10, 'Rent', 1, NULL),
      (${CC_PAYMENT}, 10, 'CC Payment', 2, NULL),
      (${ENTERTAINMENT}, 20, 'Entertainment', 0, NULL),
      (${OLD_GYM}, 30, 'Old Gym', 0, '2026-01'),
      (${SUBSCRIPTIONS}, 20, 'Subscriptions', 1, '2026-04'),
      (${UNUSED}, 40, 'Unused', 0, NULL),
      (${SECRET}, 50, 'Secret', 0, NULL);
  `);
}

/**
 * One month (2026-04) of hand-computable envelope data:
 *
 *   Groceries      assigned 50'000  spent 59'000 (60'000 out, 1'000 refunded) -> OVERSPENT by 9'000
 *   Rent           assigned 150'000 spent 150'000                             -> exactly on plan
 *   Entertainment  assigned 5'000   spent 3'000  (2'000 + a 1'000 categorized transfer)
 *   Subscriptions  assigned 2'000   spent 500    -> excluded from an April period (hidden from April),
 *                                                    but present, flagged hidden, in the 2026 year period
 *   CC Payment     assigned 99'999  spent 12'000 -> excluded (payment category)
 *   Old Gym        assigned 1'000   spent 100    -> excluded (hidden all period)
 *   Secret         assigned 3'000   spent 7'000  -> excluded (its group is hidden)
 *   Tracking row categorized to Groceries        -> excluded (off-budget)
 */
function seedMonth() {
  baseSchema();
  sqlite.exec(`
    INSERT INTO assignments (month, category_id, amount) VALUES
      ('2026-04', ${GROCERIES}, 50000),
      ('2026-04', ${RENT}, 150000),
      ('2026-04', ${ENTERTAINMENT}, 5000),
      ('2026-04', ${SUBSCRIPTIONS}, 2000),
      ('2026-04', ${CC_PAYMENT}, 99999),
      ('2026-04', ${OLD_GYM}, 1000),
      ('2026-04', ${SECRET}, 3000);

    INSERT INTO transactions (account_id, date, category_id, amount, payee) VALUES
      (1, '2026-04-02', ${GROCERIES}, -60000, 'Migros'),
      (1, '2026-04-03', ${GROCERIES}, 1000, 'Migros refund'),
      (1, '2026-04-01', ${RENT}, -150000, 'Landlord'),
      (1, '2026-04-05', ${ENTERTAINMENT}, -2000, 'Cinema'),
      (1, '2026-04-06', ${SUBSCRIPTIONS}, -500, 'Netflix'),
      (1, '2026-04-07', ${OLD_GYM}, -100, 'Gym'),
      (3, '2026-04-08', ${CC_PAYMENT}, -12000, 'Card payment'),
      (4, '2026-04-09', ${GROCERIES}, -99999, 'Off-budget'),
      (1, '2026-04-11', ${SECRET}, -7000, 'Hidden group spend');

    -- A CATEGORIZED transfer leg: the budget counts it as activity, so this
    -- report must too (unlike the cashflow queries, which drop transfers).
    INSERT INTO transactions (account_id, date, category_id, amount, payee, transfer_account_id) VALUES
      (1, '2026-04-10', ${ENTERTAINMENT}, -1000, 'To savings', 2);
  `);
}

afterEach(() => {
  sqlite.close();
});

describe("getAssignedVsSpent", () => {
  beforeEach(() => {
    sqlite = new Database(":memory:");
    seedMonth();
  });

  it("totals assigned and spent for the month against a hand-computed fixture", () => {
    const report = getAssignedVsSpent("2026-04", makeDb(), NOW);

    expect(report.months).toEqual(["2026-04"]);
    expect(report.currency).toBe("CHF");
    expect(report.assigned).toBe(50000 + 150000 + 5000);
    expect(report.spent).toBe(59000 + 150000 + 3000);
    expect(report.difference).toBe(205000 - 212000);
    expect(report.overspentCount).toBe(1);
  });

  it("nets refunds out of spend and counts categorized transfers as activity (the budget's definition)", () => {
    const report = getAssignedVsSpent("2026-04", makeDb(), NOW);
    const byName = new Map(report.groups.flatMap((g) => g.categories).map((c) => [c.name, c] as const));

    expect(byName.get("Groceries")).toMatchObject({ assigned: 50000, spent: 59000, difference: -9000 });
    expect(byName.get("Groceries")?.ratio).toBeCloseTo(59000 / 50000);
    // 2'000 cinema + a 1'000 categorized transfer leg.
    expect(byName.get("Entertainment")).toMatchObject({ spent: 3000, difference: 2000 });
  });

  it("excludes payment categories and categories hidden for the whole period", () => {
    const report = getAssignedVsSpent("2026-04", makeDb(), NOW);
    const names = report.groups.flatMap((g) => g.categories).map((c) => c.name);

    expect(names).not.toContain("CC Payment");
    expect(names).not.toContain("Old Gym");
    // Hidden from April, and April is the whole period.
    expect(names).not.toContain("Subscriptions");
    expect(report.groups.some((g) => g.name === "Archive")).toBe(false);
  });

  it("keeps a category hidden only at the end of the period, flagged hidden", () => {
    // The 2026 year period starts in January, before Subscriptions was
    // hidden, so its real April numbers still belong in the report.
    const report = getAssignedVsSpent("2026", makeDb(), NOW);
    const lines = report.groups.flatMap((g) => g.categories);

    expect(lines.find((c) => c.name === "Subscriptions")).toMatchObject({
      assigned: 2000,
      spent: 500,
      hidden: true,
    });
    expect(lines.find((c) => c.name === "Groceries")?.hidden).toBe(false);
    // Old Gym went hidden in January — the whole period — so it stays out.
    expect(lines.some((c) => c.name === "Old Gym")).toBe(false);
  });

  it("excludes categories in a hidden group, matching the budget page", () => {
    const report = getAssignedVsSpent("2026-04", makeDb(), NOW);

    expect(report.groups.some((g) => g.name === "Hidden Group")).toBe(false);
    expect(report.groups.flatMap((g) => g.categories).some((c) => c.name === "Secret")).toBe(false);
    // Its 3'000 assigned / 7'000 spent stay out of the totals, and its
    // overspend never reaches overspentCount.
    expect(report.assigned).toBe(205000);
    expect(report.spent).toBe(212000);
    expect(report.overspentCount).toBe(1);
  });

  it("omits groups with nothing assigned and nothing spent", () => {
    const report = getAssignedVsSpent("2026-04", makeDb(), NOW);
    expect(report.groups.some((g) => g.name === "Empty")).toBe(false);
  });

  it("keeps a group whose assignments cancel each other out", () => {
    // Two real lines, +10'000 moved into one category and back out of
    // another: the group's sums are 0/0, but there is plainly something to
    // look at. Filtering on the sums used to hide exactly this group.
    sqlite.exec(`
      INSERT INTO categories (id, group_id, name, sort, hidden_from) VALUES (9, 40, 'Sabbatical', 1, NULL);
      INSERT INTO assignments (month, category_id, amount) VALUES
        ('2026-04', ${UNUSED}, 10000),
        ('2026-04', 9, -10000);
    `);
    const report = getAssignedVsSpent("2026-04", makeDb(), NOW);
    const empty = report.groups.find((g) => g.name === "Empty");

    expect(empty).toMatchObject({ assigned: 0, spent: 0 });
    expect(empty?.categories.map((c) => c.name).sort()).toEqual(["Sabbatical", "Unused"]);
  });

  it("does not call a category with a negative assignment overspent", () => {
    // Money moved back OUT of a category (assigned −8'000, nothing spent)
    // rendered as "CHF 0.00 / CHF −800.00" and counted as an overspend. There
    // is no hole to plug: the plan a category is measured against is 0.
    sqlite.exec(`INSERT INTO assignments (month, category_id, amount) VALUES ('2026-04', ${UNUSED}, -800000);`);
    const report = getAssignedVsSpent("2026-04", makeDb(), NOW);
    const unused = report.groups
      .flatMap((g) => g.categories)
      .find((c) => c.name === "Unused");

    // `difference` is negative here purely because the assignment is — which
    // is exactly why the overspent test can't be `difference < 0`.
    expect(unused).toMatchObject({ assigned: -800000, spent: 0, difference: -800000 });
    // Groceries is still the only genuinely overspent category.
    expect(report.overspentCount).toBe(1);
  });

  it("counts real spending against a negative assignment as overspent", () => {
    sqlite.exec(`
      INSERT INTO assignments (month, category_id, amount) VALUES ('2026-04', ${UNUSED}, -800000);
      INSERT INTO transactions (account_id, date, category_id, amount, payee) VALUES
        (1, '2026-04-12', ${UNUSED}, -5000, 'Spent anyway');
    `);
    expect(getAssignedVsSpent("2026-04", makeDb(), NOW).overspentCount).toBe(2);
  });

  it("sorts groups by their biggest side, so an unplanned spender leads", () => {
    // Nothing assigned, 300'000 spent: the group that most needs looking at
    // sorted last while groups were ranked by assigned alone.
    sqlite.exec(`
      INSERT INTO transactions (account_id, date, category_id, amount, payee) VALUES
        (1, '2026-04-13', ${UNUSED}, -300000, 'Surprise');
    `);
    const report = getAssignedVsSpent("2026-04", makeDb(), NOW);

    expect(report.groups.map((g) => g.name)).toEqual(["Empty", "Spending", "Fun"]);
    expect(report.groups[0]).toMatchObject({ assigned: 0, spent: 300000 });
  });

  it("rolls category lines up into group totals, overspent categories first", () => {
    const report = getAssignedVsSpent("2026-04", makeDb(), NOW);

    expect(report.groups.map((g) => g.name)).toEqual(["Spending", "Fun"]);
    const spending = report.groups[0];
    expect(spending).toMatchObject({ assigned: 200000, spent: 209000, difference: -9000 });
    // Groceries is overspent so it sorts ahead of the larger-but-on-plan Rent.
    expect(spending.categories.map((c) => c.name)).toEqual(["Groceries", "Rent"]);
    // Neither Fun category is overspent, so they fall back to spend
    // descending (over the year period, where Subscriptions is still in).
    const year = getAssignedVsSpent("2026", makeDb(), NOW);
    expect(year.groups[1].categories.map((c) => c.name)).toEqual(["Entertainment", "Subscriptions"]);
  });

  it("reports a null ratio when nothing was assigned", () => {
    sqlite.exec(`DELETE FROM assignments WHERE category_id = ${GROCERIES};`);
    const report = getAssignedVsSpent("2026-04", makeDb(), NOW);
    const groceries = report.groups.flatMap((g) => g.categories).find((c) => c.name === "Groceries");

    expect(groceries).toMatchObject({ assigned: 0, spent: 59000, difference: -59000, ratio: null });
  });

  it("covers a running year up to the current month, and all time from the first month with data", () => {
    expect(getAssignedVsSpent("2026", makeDb(), NOW).months).toEqual([
      "2026-01", "2026-02", "2026-03", "2026-04",
    ]);
    expect(getAssignedVsSpent("2025", makeDb(), NOW).months).toHaveLength(12);
    expect(getAssignedVsSpent("all", makeDb(), NOW).months).toEqual(["2026-04"]);
  });
});

/**
 * Chronic fixture. With `NOW` in April, the window is the six FULL months
 * 2025-10 .. 2026-03; April is deliberately loaded with a huge overspend that
 * must be ignored.
 *
 *   Groceries      assigned 10'000/mo, spent 12'000 in exactly 3 months  -> chronically over (boundary)
 *   Entertainment  assigned 5'000/mo,  spent 7'000 in only 2 months      -> not over (one short)
 *   Subscriptions  assigned 10'000 in 5 months, spent 1'000 in exactly 4 -> chronically under (boundary)
 *   Rent           assigned 8'000 in 4 months, underspent in only 3      -> not under (one short)
 *   Unused         spending but never assigned                          -> skipped (no plan)
 *   Secret         assigned 1'000/mo, spent 90'000 every month           -> skipped (hidden group)
 */
function seedChronic() {
  baseSchema();
  const assignments: string[] = [];
  const txns: string[] = [];
  const window = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"];

  window.forEach((month, i) => {
    assignments.push(`('${month}', ${GROCERIES}, 10000)`);
    txns.push(`(1, '${month}-05', ${GROCERIES}, ${i < CHRONIC_OVER_MIN_HITS ? -12000 : -10000}, 'Migros')`);

    assignments.push(`('${month}', ${ENTERTAINMENT}, 5000)`);
    txns.push(`(1, '${month}-06', ${ENTERTAINMENT}, ${i < 2 ? -7000 : -5000}, 'Cinema')`);

    // Subscriptions: assigned in the first 5 window months only.
    if (i < 5) {
      assignments.push(`('${month}', ${SUBSCRIPTIONS}, 10000)`);
      txns.push(`(1, '${month}-07', ${SUBSCRIPTIONS}, ${i < CHRONIC_UNDER_MIN_HITS ? -1000 : -10000}, 'Netflix')`);
    }

    // Rent: assigned in 4 months, heavily underspent in only 3 of them.
    if (i < 4) {
      assignments.push(`('${month}', ${RENT}, 8000)`);
      txns.push(`(1, '${month}-08', ${RENT}, ${i < 3 ? -500 : -8000}, 'Landlord')`);
    }

    txns.push(`(1, '${month}-09', ${UNUSED}, -50000, 'No plan')`);

    // Secret sits in a hidden group and is chronically overspent every month.
    assignments.push(`('${month}', ${SECRET}, 1000)`);
    txns.push(`(1, '${month}-10', ${SECRET}, -90000, 'Hidden group spend')`);
  });

  // The running month: a massive overspend that must not be counted.
  txns.push(`(1, '2026-04-05', ${GROCERIES}, -900000, 'Migros')`);
  assignments.push(`('2026-04', ${GROCERIES}, 10000)`);

  sqlite.exec(`INSERT INTO assignments (month, category_id, amount) VALUES ${assignments.join(",")};`);
  sqlite.exec(`INSERT INTO transactions (account_id, date, category_id, amount, payee) VALUES ${txns.join(",")};`);
}

describe("getChronicCategories", () => {
  beforeEach(() => {
    sqlite = new Database(":memory:");
    seedChronic();
  });

  it("flags a category that overspends in exactly the minimum number of full months", () => {
    const { over, currency } = getChronicCategories(makeDb(), NOW);

    expect(currency).toBe("CHF");
    expect(over.map((c) => c.name)).toEqual(["Groceries"]);
    expect(over[0]).toMatchObject({
      groupName: "Spending",
      monthsHit: CHRONIC_OVER_MIN_HITS,
      monthsConsidered: 6,
      averageGap: 2000,
    });
  });

  it("does not flag a category one month short of the threshold", () => {
    const { over } = getChronicCategories(makeDb(), NOW);
    expect(over.some((c) => c.name === "Entertainment")).toBe(false);
  });

  it("ignores the running month", () => {
    // Groceries' April overspend is 900'000; if April counted, averageGap
    // would explode and monthsHit would be 4.
    const { over } = getChronicCategories(makeDb(), NOW);
    expect(over[0].monthsHit).toBe(CHRONIC_OVER_MIN_HITS);
    expect(over[0].averageGap).toBe(2000);
  });

  it("flags chronic underspend and counts only the months with an assignment", () => {
    const { under } = getChronicCategories(makeDb(), NOW);

    expect(under.map((c) => c.name)).toEqual(["Subscriptions"]);
    expect(under[0]).toMatchObject({
      monthsHit: CHRONIC_UNDER_MIN_HITS,
      monthsConsidered: 5, // assigned in 5 of the 6 window months
      averageGap: 9000,
    });
  });

  it("does not flag underspend one month short of the threshold", () => {
    const { under } = getChronicCategories(makeDb(), NOW);
    expect(under.some((c) => c.name === "Rent")).toBe(false);
  });

  it("skips categories in a hidden group even when they overspend every month", () => {
    const { over, under } = getChronicCategories(makeDb(), NOW);
    // Secret's 89'000 average gap would top the list if it counted.
    expect([...over, ...under].some((c) => c.name === "Secret")).toBe(false);
    expect(over[0].name).toBe("Groceries");
  });

  it("does not count a month with no assignment as an overspend", () => {
    // Strip the envelopes from the three months Groceries overspent: with no
    // assignment there is no plan to bust, so those months are not evidence.
    sqlite.exec(`
      DELETE FROM assignments
      WHERE category_id = ${GROCERIES} AND month IN ('2025-10', '2025-11', '2025-12');
    `);
    const { over } = getChronicCategories(makeDb(), NOW);

    expect(over.some((c) => c.name === "Groceries")).toBe(false);
  });

  it("counts only the months with an assignment toward monthsConsidered", () => {
    sqlite.exec(`DELETE FROM assignments WHERE category_id = ${GROCERIES} AND month = '2026-03';`);
    const { over } = getChronicCategories(makeDb(), NOW);

    expect(over[0]).toMatchObject({ name: "Groceries", monthsHit: CHRONIC_OVER_MIN_HITS, monthsConsidered: 5 });
  });

  it("skips categories that were never assigned anything (no plan to miss)", () => {
    const { over, under } = getChronicCategories(makeDb(), NOW);
    expect([...over, ...under].some((c) => c.name === "Unused")).toBe(false);
  });
});

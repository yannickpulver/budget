import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import {
  delta,
  getCategoryOutflowBetween,
  getLargestTransactions,
  getMonthlyCashflow,
  getNetWorthHistory,
  netWorthAt,
  getSpendingByGroup,
  getTopPayees,
  getTrips,
  stripGroupPrefix,
} from "./stats-queries";

/**
 * Integration tests for the stats-page query layer. Uses a throwaway
 * in-memory SQLite fixture (mirrors the pattern in queries.test.ts), extended
 * with holdings/prices for the net-worth live-valuation swap.
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

// Category ids.
const GROCERIES = 1;
const RENT = 2;
const CC_PAYMENT = 3;
const ENTERTAINMENT = 4;
const TRIP_A = 5; // group name "3. TRIPS Japan" — mixed-case "trips" match.
const TRIP_B = 6; // hidden category, group "Trips Europe".
const SALARY = 7;
const GIFTCARDS = 8; // inflow-only category/group, used to test the zero-outflow filter.

const NOW = new Date("2026-04-15T12:00:00Z");

function seed() {
  sqlite.exec(DDL);
  sqlite.exec(`
    INSERT INTO accounts (id, name, type, payment_category_id) VALUES
      (1, 'Checking', 'checking', NULL),
      (2, 'Savings', 'savings', NULL),
      (3, 'Credit', 'credit', ${CC_PAYMENT}),
      (4, 'Tracking', 'tracking', NULL);

    INSERT INTO category_groups (id, name, sort, hidden) VALUES
      (5, '0. Income', 0, 0),
      (10, '1. Spending', 1, 0),
      (20, '2. Fun', 2, 0),
      (30, '3. TRIPS Japan', 3, 0),
      (40, 'Trips Europe', 4, 0),
      (60, 'Giftcards', 5, 0);

    INSERT INTO categories (id, group_id, name, sort, hidden_from) VALUES
      (${SALARY}, 5, 'Salary', 0, NULL),
      (${GROCERIES}, 10, 'Groceries', 0, NULL),
      (${RENT}, 10, 'Rent', 1, NULL),
      (${CC_PAYMENT}, 10, 'CC Payment', 2, NULL),
      (${ENTERTAINMENT}, 20, 'Entertainment', 0, NULL),
      (${TRIP_A}, 30, 'Trip', 0, NULL),
      (${TRIP_B}, 40, 'Trip', 0, '0000-01'),
      (${GIFTCARDS}, 60, 'Giftcards', 0, NULL);

    -- 2025-06: Trip B spend (hidden category, single day).
    INSERT INTO transactions (account_id, date, category_id, amount, payee) VALUES
      (1, '2025-06-01', ${TRIP_B}, -20000, 'Train');

    -- 2025-07: Trip A spend + a refund.
    INSERT INTO transactions (account_id, date, category_id, amount, payee) VALUES
      (1, '2025-07-01', ${TRIP_A}, -50000, 'Hotel Tokyo'),
      (1, '2025-07-05', ${TRIP_A}, -30000, 'Hotel Tokyo'),
      (1, '2025-07-10', ${TRIP_A}, 5000, 'Refund');

    -- 2026-01: income (uncategorized -- flows to Ready to Assign, per YNAB
    -- envelope budgeting) + spend + a tracking-account deposit (cost basis)
    -- + the two synthetic bookkeeping payees, which must NOT count as income.
    INSERT INTO transactions (account_id, date, category_id, amount, payee) VALUES
      (1, '2026-01-05', NULL, 500000, 'Employer'),
      (1, '2026-01-06', NULL, 3000, 'Starting Balance'),
      (1, '2026-01-07', NULL, 4000, 'Balance Adjustment'),
      (1, '2026-01-10', ${GROCERIES}, -8000, 'Migros'),
      (1, '2026-01-12', ${RENT}, -150000, 'Landlord'),
      (4, '2026-01-15', NULL, 100000, 'Deposit');

    -- 2026-02: an inter-account transfer (excluded from cashflow/group/payees)
    -- plus ordinary spend.
    INSERT INTO transactions (account_id, date, category_id, amount, payee, transfer_account_id) VALUES
      (1, '2026-02-01', NULL, -20000, 'Transfer', 2),
      (2, '2026-02-01', NULL, 20000, 'Transfer', 1);
    INSERT INTO transactions (account_id, date, category_id, amount, payee) VALUES
      (1, '2026-02-08', ${GROCERIES}, -5000, 'Migros');

    -- 2026-03: nothing (a gap month).

    -- 2026-04: entertainment spend, an empty-payee row, a credit-card
    -- purchase, and its payment (categorized to the payment category, so
    -- excluded from cashflow/group/payee totals despite being categorized),
    -- plus an inflow-only "Giftcards" category (a refund with no matching
    -- outflow in the period), which must not render as a 0-outflow group.
    INSERT INTO transactions (account_id, date, category_id, amount, payee) VALUES
      (1, '2026-04-05', ${ENTERTAINMENT}, -3000, 'Cinema'),
      (1, '2026-04-08', ${GROCERIES}, -1000, ''),
      (3, '2026-04-10', ${GROCERIES}, -12000, 'Coop'),
      (1, '2026-04-14', ${GIFTCARDS}, 2500, 'Giftcard refund');
    INSERT INTO transactions (account_id, date, category_id, amount, payee, transfer_account_id) VALUES
      (1, '2026-04-12', ${CC_PAYMENT}, -12000, 'Credit Card', NULL),
      (3, '2026-04-12', NULL, 12000, 'Payment', 1);

    -- Account 4 ('Tracking') deliberately has NO holdings rows by default —
    -- this is the common case (a balance-tracked account like a pension),
    -- and net worth must keep its transaction-derived balance untouched.
    -- Individual getNetWorthHistory tests below add holdings rows to
    -- exercise the other two branches (fully priced / partially priced).
  `);
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  seed();
});

afterEach(() => {
  sqlite.close();
});

describe("stripGroupPrefix", () => {
  it("removes a leading numbered ordering prefix", () => {
    expect(stripGroupPrefix("1. Spending")).toBe("Spending");
    expect(stripGroupPrefix("12. Big Purchases")).toBe("Big Purchases");
  });

  it("leaves names without a prefix untouched", () => {
    expect(stripGroupPrefix("Trips Europe")).toBe("Trips Europe");
  });
});

describe("getNetWorthHistory", () => {
  it("carries the running balance through empty months with no gaps", () => {
    const { points, currency, liveValuation } = getNetWorthHistory(makeDb(), NOW);

    expect(currency).toBe("CHF");
    expect(points.map((p) => p.month)).toEqual([
      "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11",
      "2025-12", "2026-01", "2026-02", "2026-03", "2026-04",
    ]);

    // 2025-06: Trip B -20000.
    expect(points[0].balance).toBe(-20000);
    // 2025-07: -50000 -30000 +5000 => running -95000.
    expect(points[1].balance).toBe(-95000);
    // Gap months carry the balance forward unchanged.
    expect(points[2].balance).toBe(-95000);
    expect(points[6].balance).toBe(-95000); // 2025-12
    // 2026-01: +500000 +3000(Starting Balance) +4000(Balance Adjustment)
    // -8000 -150000 +100000(tracking deposit) => +449000 => running 354000.
    // (Net worth is every transaction regardless of category, so the two
    // synthetic bookkeeping payees still move the balance even though the
    // income definition excludes them.)
    expect(points[7].balance).toBe(354000);
    // 2026-02: -20000 +20000 -5000 => -5000 => running 349000.
    expect(points[8].balance).toBe(349000);
    // 2026-03: gap, unchanged.
    expect(points[9].balance).toBe(349000);

    // Account 4 has no holdings rows at all (the pension-account case): no swap
    // happens anywhere, so liveValuation is false by default.
    expect(liveValuation).toBe(false);
  });

  // Transaction-derived running balance through April is 335500 regardless
  // of the tracking-account branch below (349000 - 13500 net April
  // movement, none of which touches account 4's 100000 cost-basis deposit).
  const TRANSACTION_DERIVED_APRIL_BALANCE = 335500;

  it("keeps a zero-holdings tracking account's transaction-derived balance untouched (the pension-account case)", () => {
    // Account 4 has no `holdings` rows in the base fixture — tracked by
    // balance, not by instrument.
    const { points, liveValuation } = getNetWorthHistory(makeDb(), NOW);
    const last = points[points.length - 1];

    expect(last.month).toBe("2026-04");
    expect(last.balance).toBe(TRANSACTION_DERIVED_APRIL_BALANCE);
    expect(liveValuation).toBe(false);

    // Every earlier point is unaffected either way.
    expect(points[points.length - 2].balance).toBe(349000);
  });

  it("swaps a tracking account's cost basis for live valuation when every held symbol is priced", () => {
    sqlite.exec(`
      INSERT INTO holdings (account_id, symbol, name, quantity) VALUES (4, 'ABC', 'Widget Corp', 10);
      INSERT INTO prices (symbol, price_rappen, fetched_at) VALUES ('ABC', 15000, '2026-04-15T00:00:00Z');
    `);
    const { points, liveValuation } = getNetWorthHistory(makeDb(), NOW);
    const last = points[points.length - 1];

    // The +100000 cost-basis deposit is swapped for the 10 * 15000 = 150000
    // live valuation: 335500 - 100000 + 150000 = 385500.
    expect(last.balance).toBe(TRANSACTION_DERIVED_APRIL_BALANCE - 100000 + 150000);
    expect(liveValuation).toBe(true);
  });

  it("keeps the transaction-derived balance when at least one held symbol has no price (can't be fully valued)", () => {
    sqlite.exec(`
      INSERT INTO holdings (account_id, symbol, name, quantity) VALUES
        (4, 'ABC', 'Widget Corp', 10),
        (4, 'XYZ', 'Unpriced Inc', 5);
      INSERT INTO prices (symbol, price_rappen, fetched_at) VALUES ('ABC', 15000, '2026-04-15T00:00:00Z');
    `);
    const { points, liveValuation } = getNetWorthHistory(makeDb(), NOW);
    const last = points[points.length - 1];

    // A partial sum (just the priced ABC holding) would understate the
    // account, so the cost basis is kept instead of being swapped.
    expect(last.balance).toBe(TRANSACTION_DERIVED_APRIL_BALANCE);
    expect(liveValuation).toBe(false);
  });

  it("returns liveValuation=false and an empty history when there are no transactions", () => {
    sqlite.exec("DELETE FROM transactions;");
    const { points, liveValuation } = getNetWorthHistory(makeDb(), NOW);
    expect(points).toEqual([]);
    expect(liveValuation).toBe(false);
  });
});

describe("getMonthlyCashflow", () => {
  it("computes income/spending/net for a month period, excluding transfers/tracking/payment-category rows", () => {
    const summary = getMonthlyCashflow("2026-01", makeDb(), NOW);

    expect(summary.bucket).toBe("month");
    // 12-month display window ending at the period month.
    expect(summary.entries[0].key).toBe("2025-02");
    expect(summary.entries.at(-1)?.key).toBe("2026-01");
    expect(summary.entries).toHaveLength(12);

    const jan = summary.entries.find((m) => m.key === "2026-01");
    expect(jan?.income).toBe(500000);
    expect(jan?.spending).toBe(158000); // 8000 groceries + 150000 rent
    expect(jan?.inPeriod).toBe(true);
    expect(summary.entries.find((m) => m.key === "2025-06")?.inPeriod).toBe(false);

    expect(summary.income).toBe(500000);
    expect(summary.spending).toBe(158000);
    expect(summary.net).toBe(342000);
    expect(summary.savingsRate).toBeCloseTo(342000 / 500000);
    expect(summary.avgSpendingPerMonth).toBe(158000);
  });

  it("excludes transfers, tracking accounts, and credit-card payment categories", () => {
    const summary = getMonthlyCashflow("2026-04", makeDb(), NOW);
    const apr = summary.entries.find((m) => m.key === "2026-04");

    // Entertainment 3000 + empty-payee groceries 1000 + credit-card
    // purchase on the (non-tracking) Credit account 12000 = 16000. The
    // checking-side card payment (-12000, categorized to the payment
    // category) is excluded.
    expect(apr?.spending).toBe(16000);
  });

  it("trims a year period's window to the current month and reports null savingsRate when income is 0", () => {
    const summary = getMonthlyCashflow("2026", makeDb(), NOW);

    expect(summary.bucket).toBe("month");
    expect(summary.entries.map((m) => m.key)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(summary.spending).toBe(158000 + 5000 + 0 + 16000);
    expect(summary.income).toBe(500000);

    const noIncomeMonth = summary.entries.find((m) => m.key === "2026-03");
    expect(noIncomeMonth?.income).toBe(0);
    expect(noIncomeMonth?.savingsRate).toBeNull();
  });

  it("aggregates by calendar year for 'all', while keeping avgSpendingPerMonth a per-month average", () => {
    const summary = getMonthlyCashflow("all", makeDb(), NOW);

    expect(summary.bucket).toBe("year");
    expect(summary.entries.map((e) => e.key)).toEqual(["2025", "2026"]);
    expect(summary.entries.every((e) => e.inPeriod)).toBe(true);
    expect(summary.entries[0]).toMatchObject({ label: "2025", income: 0, spending: 100000 }); // Trip B 20000 + Trip A 80000
    expect(summary.entries[1]).toMatchObject({
      label: "2026",
      income: 500000,
      spending: 179000, // 158000 (Jan) + 5000 (Feb) + 0 (Mar) + 16000 (Apr)
    });

    expect(summary.income).toBe(500000);
    expect(summary.spending).toBe(279000);
    expect(summary.net).toBe(221000);

    // 11 calendar months elapsed (2025-06 .. 2026-04), not 2 (the year
    // buckets) — the average must stay per-month regardless of bucketing.
    expect(summary.avgSpendingPerMonth).toBe(Math.round(279000 / 11));
  });

  it("counts a null-category inflow as income (real income flows to Ready to Assign, uncategorized)", () => {
    const summary = getMonthlyCashflow("2026-01", makeDb(), NOW);
    const jan = summary.entries.find((m) => m.key === "2026-01");
    expect(jan?.income).toBe(500000); // the 'Employer' deposit, categoryId null
  });

  it("excludes 'Starting Balance' and 'Balance Adjustment' inflows from income", () => {
    const summary = getMonthlyCashflow("2026-01", makeDb(), NOW);
    const jan = summary.entries.find((m) => m.key === "2026-01");
    // Without the exclusion this would be 500000 + 3000 + 4000.
    expect(jan?.income).toBe(500000);
  });

  it("does not count a categorized positive row (a refund) as income", () => {
    const summary = getMonthlyCashflow("2026-01", makeDb(), NOW);
    // 2025-07 has a +5000 'Refund' row, but it's categorized (Trip A), so it
    // must not show up as income.
    const jul2025 = summary.entries.find((m) => m.key === "2025-07");
    expect(jul2025?.income).toBe(0);
  });
});

describe("getSpendingByGroup", () => {
  it("aggregates outflow per group, strips the numbering prefix, and computes share", () => {
    const { groups, total, currency } = getSpendingByGroup("2026-04", makeDb());

    expect(currency).toBe("CHF");
    expect(total).toBe(13000 + 3000); // Groceries(1000+12000) + Entertainment(3000); CC payment excluded
    expect(groups[0]).toMatchObject({ name: "Spending", outflow: 13000 });
    expect(groups[1]).toMatchObject({ name: "Fun", outflow: 3000 });
    expect(groups[0].share).toBeCloseTo(13000 / 16000);
    expect(groups[1].share).toBeCloseTo(3000 / 16000);
  });

  it("omits a group with inflow but zero outflow (an all-refund category)", () => {
    const { groups } = getSpendingByGroup("2026-04", makeDb());
    expect(groups.some((g) => g.name === "Giftcards")).toBe(false);
  });

  // Fix 4: `count` renders as an "Nx" purchase hint in the UI, so a refund row
  // must not inflate it.
  it("counts only outflow rows, not a refund landing in the same group", () => {
    sqlite.exec(`
      INSERT INTO transactions (account_id, date, category_id, amount, payee) VALUES
        (1, '2026-04-20', ${ENTERTAINMENT}, 1000, 'Refund');
    `);
    const { groups } = getSpendingByGroup("2026-04", makeDb());
    const fun = groups.find((g) => g.name === "Fun");
    expect(fun?.count).toBe(1);
  });
});

describe("getTopPayees", () => {
  it("ranks payees by outflow, mapping an empty payee to '(no payee)'", () => {
    const payees = getTopPayees("2026-04", 10, makeDb());

    expect(payees.map((p) => p.payee)).toEqual(["Coop", "Cinema", "(no payee)"]);
    expect(payees[0]).toMatchObject({ outflow: 12000, count: 1 });
  });

  it("respects the limit", () => {
    const payees = getTopPayees("2026-04", 1, makeDb());
    expect(payees).toHaveLength(1);
    expect(payees[0].payee).toBe("Coop");
  });

  // Fix 4: `count` renders as an "Nx" purchase hint in the UI, so a refund
  // from the same payee must not inflate it.
  it("counts only outflow rows, not a refund from the same payee", () => {
    sqlite.exec(`
      INSERT INTO transactions (account_id, date, category_id, amount, payee) VALUES
        (1, '2026-04-20', ${ENTERTAINMENT}, 1000, 'Coop');
    `);
    const payees = getTopPayees("2026-04", 10, makeDb());
    const coop = payees.find((p) => p.payee === "Coop");
    expect(coop?.count).toBe(1);
  });
});

describe("getTrips", () => {
  it("aggregates every trip category (hidden included), all-time, sorted by lastDate descending", () => {
    const { trips, currency } = getTrips(makeDb());

    expect(currency).toBe("CHF");
    expect(trips).toHaveLength(2);
    expect(trips.map((t) => t.categoryId)).toEqual([TRIP_A, TRIP_B]); // Trip A's last date is later

    const tripA = trips[0];
    expect(tripA.outflow).toBe(80000);
    expect(tripA.inflow).toBe(5000);
    expect(tripA.total).toBe(75000);
    expect(tripA.count).toBe(3);
    expect(tripA.firstDate).toBe("2025-07-01");
    expect(tripA.lastDate).toBe("2025-07-10");
    expect(tripA.days).toBe(10);
    expect(tripA.costPerDay).toBe(7500);
    expect(tripA.topPayees).toEqual([{ payee: "Hotel Tokyo", outflow: 80000, count: 2 }]);

    const tripB = trips[1];
    expect(tripB.days).toBe(1);
    expect(tripB.total).toBe(20000);
    expect(tripB.costPerDay).toBe(20000);
  });

  it("omits ongoing funds (monthly funding target) like a Travel Fund", () => {
    sqlite.exec(`
      INSERT INTO categories (id, group_id, name, monthly_target, target_type) VALUES (98, 30, 'Travel Fund', 50000, 'monthly');
      INSERT INTO transactions (account_id, date, category_id, amount, payee) VALUES (1, '2025-08-01', 98, -10000, 'Airline');
    `);
    const { trips } = getTrips(makeDb());
    expect(trips.some((t) => t.categoryId === 98)).toBe(false);
  });

  it("omits trip categories with no transactions", () => {
    sqlite.exec(`
      INSERT INTO category_groups (id, name) VALUES (50, 'Trips Iceland');
      INSERT INTO categories (id, group_id, name) VALUES (99, 50, 'Iceland');
    `);
    const { trips } = getTrips(makeDb());
    expect(trips.some((t) => t.categoryId === 99)).toBe(false);
  });
});

describe("delta", () => {
  it("reports the absolute and relative change", () => {
    const d = delta(15000, 10000);
    expect(d).toMatchObject({ current: 15000, previous: 10000, change: 5000 });
    expect(d.percent).toBeCloseTo(0.5);
  });

  it("suppresses the percentage when the previous period is below the CHF 20 floor", () => {
    // A CHF 4 base turning into CHF 150 is "+3650%" — true, and useless.
    expect(delta(15000, 400).percent).toBeNull();
    expect(delta(15000, 400).change).toBe(14600);
    // Exactly at the floor it is meaningful again.
    expect(delta(4000, 2000).percent).toBeCloseTo(1);
  });

  it("suppresses the percentage when the previous period is zero", () => {
    expect(delta(15000, 0).percent).toBeNull();
  });

  it("divides by the magnitude of the base, so the percentage carries the change's sign", () => {
    // A net of −CHF 100 deepening to −CHF 150 is a 50% move DOWN. Dividing by
    // a signed base would report it as +50%.
    const worse = delta(-15000, -10000);
    expect(worse.change).toBe(-5000);
    expect(worse.percent).toBeCloseTo(-0.5);

    const better = delta(-5000, -10000);
    expect(better.change).toBe(5000);
    expect(better.percent).toBeCloseTo(0.5);
  });

  it("suppresses the percentage when the two figures straddle zero", () => {
    // −CHF 1'200 to +CHF 1'700 rendered as "−243%", which reads as a
    // catastrophe rather than as the recovery it is.
    expect(delta(170000, -120000).percent).toBeNull();
    expect(delta(170000, -120000).change).toBe(290000);
    expect(delta(-120000, 170000).percent).toBeNull();
  });
});

describe("netWorthAt", () => {
  it("returns the balance carried into the given month", () => {
    const { points } = getNetWorthHistory(makeDb(), NOW);
    expect(netWorthAt(points, "2026-02")).toBe(349000);
    // A gap month carries the previous balance forward.
    expect(netWorthAt(points, "2026-03")).toBe(349000);
  });

  it("returns null before the history starts", () => {
    const { points } = getNetWorthHistory(makeDb(), NOW);
    expect(netWorthAt(points, "2025-05")).toBeNull();
  });
});

describe("getMonthlyCashflow comparisons", () => {
  it("computes the previous period's totals over the whole previous month for a finished period", () => {
    const summary = getMonthlyCashflow("2026-02", makeDb(), NOW);

    expect(summary.partial).toBe(false);
    expect(summary.previous).toEqual({ income: 500000, spending: 158000, net: 342000 });
  });

  it("marks a running period partial and compares month-to-date", () => {
    const summary = getMonthlyCashflow("2026-04", makeDb(), NOW);

    expect(summary.partial).toBe(true);
    // March is empty, and the month-to-date cut (through the 15th) can only
    // shrink it further.
    expect(summary.previous).toEqual({ income: 0, spending: 0, net: 0 });
  });

  it("has no comparison for all time", () => {
    expect(getMonthlyCashflow("all", makeDb(), NOW).previous).toBeNull();
  });

  it("cuts a running period's own totals at today, matching the comparison window", () => {
    const asOf9th = getMonthlyCashflow("2026-04", makeDb(), new Date("2026-04-09T12:00:00Z"));
    const asOf15th = getMonthlyCashflow("2026-04", makeDb(), NOW);

    // Cinema (5th) + the empty-payee row (8th); Coop lands on the 10th.
    expect(asOf9th.spending).toBe(4000);
    expect(asOf15th.spending).toBe(16000);
    // The display window still shows the whole month.
    expect(asOf9th.entries.at(-1)).toMatchObject({ key: "2026-04", spending: 16000 });
  });

  it("leaves a finished period on its full calendar bounds", () => {
    expect(getMonthlyCashflow("2026-01", makeDb(), NOW)).toMatchObject({
      partial: false,
      spending: 158000,
      months: 1,
    });
  });

  it("returns a 12-month trailing series ending at the period's last month", () => {
    const summary = getMonthlyCashflow("2026-02", makeDb(), NOW);

    expect(summary.trailing.months).toHaveLength(12);
    expect(summary.trailing.income).toHaveLength(12);
    expect(summary.trailing.spending).toHaveLength(12);
    expect(summary.trailing.net).toHaveLength(12);
    expect(summary.trailing.months[0]).toBe("2025-03");
    expect(summary.trailing.months.at(-1)).toBe("2026-02");

    const jan = summary.trailing.months.indexOf("2026-01");
    expect(summary.trailing.income[jan]).toBe(500000);
    expect(summary.trailing.spending[jan]).toBe(158000);
    expect(summary.trailing.net[jan]).toBe(342000);
  });

  it("ends the trailing series at the current month for a running year and for all time", () => {
    expect(getMonthlyCashflow("2026", makeDb(), NOW).trailing.months.at(-1)).toBe("2026-04");
    expect(getMonthlyCashflow("all", makeDb(), NOW).trailing.months.at(-1)).toBe("2026-04");
    expect(getMonthlyCashflow("all", makeDb(), NOW).trailing.months).toHaveLength(12);
  });

  it("ends the trailing series at December for a finished year", () => {
    expect(getMonthlyCashflow("2025", makeDb(), NOW).trailing.months.at(-1)).toBe("2025-12");
  });
});

describe("getSpendingByGroup breakdown", () => {
  it("breaks each group into categories whose shares sum to 1", () => {
    const { groups } = getSpendingByGroup("all", makeDb(), NOW);

    const spending = groups.find((g) => g.name === "Spending");
    expect(spending?.categories.map((c) => c.name)).toEqual(["Rent", "Groceries"]);
    expect(spending?.categories.map((c) => c.outflow)).toEqual([150000, 26000]);
    for (const group of groups) {
      const sum = group.categories.reduce((s, c) => s + c.share, 0);
      expect(sum).toBeCloseTo(1);
      expect(group.categories.reduce((s, c) => s + c.outflow, 0)).toBe(group.outflow);
    }
  });

  it("omits zero-outflow categories from a group's breakdown", () => {
    const { groups } = getSpendingByGroup("2026-04", makeDb(), NOW);
    expect(groups.flatMap((g) => g.categories).every((c) => c.outflow > 0)).toBe(true);
    expect(groups.flatMap((g) => g.categories).some((c) => c.name === "Giftcards")).toBe(false);
  });

  it("carries the previous period's outflow per group and per category", () => {
    const { groups } = getSpendingByGroup("2026-02", makeDb(), NOW);

    const spending = groups.find((g) => g.name === "Spending");
    expect(spending?.outflow).toBe(5000); // Feb groceries
    expect(spending?.previousOutflow).toBe(158000); // Jan: 8000 groceries + 150000 rent
    expect(spending?.categories[0]).toMatchObject({ name: "Groceries", previousOutflow: 8000 });
  });

  it("has no previous outflow for all time", () => {
    const { groups } = getSpendingByGroup("all", makeDb(), NOW);
    expect(groups.every((g) => g.previousOutflow === null)).toBe(true);
    expect(groups.flatMap((g) => g.categories).every((c) => c.previousOutflow === null)).toBe(true);
  });

  it("keeps a group that spent nothing this period but something last one", () => {
    // March is empty; February had 5'000 of groceries. "Spending CHF 0,
    // −CHF 50 vs Feb" is the row the comparison exists for.
    const { groups, total } = getSpendingByGroup("2026-03", makeDb(), NOW);

    const spending = groups.find((g) => g.name === "Spending");
    expect(spending).toMatchObject({ outflow: 0, previousOutflow: 5000 });
    expect(spending?.categories).toEqual([
      expect.objectContaining({ name: "Groceries", outflow: 0, count: 0, previousOutflow: 5000 }),
    ]);
    // The period total is still the period's own spend.
    expect(total).toBe(0);
  });

  it("cuts a running period at today, so both sides of the comparison span the same days", () => {
    // April 9th: the 12'000 Coop purchase on the 10th has not happened yet.
    const { groups, total } = getSpendingByGroup("2026-04", makeDb(), new Date("2026-04-09T12:00:00Z"));

    expect(total).toBe(1000 + 3000);
    expect(groups.find((g) => g.name === "Spending")?.outflow).toBe(1000);
  });
});

describe("getLargestTransactions", () => {
  it("returns outflows by magnitude with category and account names", () => {
    const { rows, currency } = getLargestTransactions("2026-04", 8, makeDb());

    expect(currency).toBe("CHF");
    expect(rows.map((r) => [r.payee, r.amount])).toEqual([
      ["Coop", 12000],
      ["Cinema", 3000],
      ["(no payee)", 1000],
    ]);
    expect(rows[0]).toMatchObject({
      date: "2026-04-10",
      categoryName: "Groceries",
      accountName: "Credit",
    });
  });

  it("excludes payment categories, transfers, inflows and tracking accounts", () => {
    const { rows } = getLargestTransactions("2026-04", 8, makeDb());
    // The -12000 card payment (payment category) would otherwise tie for first.
    expect(rows.some((r) => r.categoryName === "CC Payment")).toBe(false);
    expect(rows.some((r) => r.payee === "Transfer")).toBe(false);
    expect(rows.every((r) => r.amount > 0)).toBe(true);
  });

  it("honours the limit", () => {
    expect(getLargestTransactions("all", 2, makeDb()).rows.map((r) => r.amount)).toEqual([150000, 50000]);
  });

  it("cuts a running period at today, like the totals above it", () => {
    const { rows } = getLargestTransactions("2026-04", 8, makeDb(), new Date("2026-04-09T12:00:00Z"));
    // The 12'000 Coop purchase is dated the 10th — still in the future.
    expect(rows.map((r) => [r.payee, r.amount])).toEqual([
      ["Cinema", 3000],
      ["(no payee)", 1000],
    ]);
  });
});

describe("getCategoryOutflowBetween", () => {
  it("sums one category's outflow over a day range", () => {
    // Groceries: 8000 (Jan 10) + 5000 (Feb 8) + 1000 + 12000 (April).
    expect(getCategoryOutflowBetween(GROCERIES, "2026-01-01", "2026-03-01", makeDb())).toBe(13000);
    // Month-to-date fairness: a cut range stops mid-month.
    expect(getCategoryOutflowBetween(GROCERIES, "2026-04-01", "2026-04-09", makeDb())).toBe(1000);
  });

  it("treats null bounds as unbounded", () => {
    expect(getCategoryOutflowBetween(GROCERIES, null, null, makeDb())).toBe(26000);
  });

  it("excludes uncategorized rows and transfer legs in all-categories mode", () => {
    // February holds a 20000 transfer pair plus 5000 of groceries.
    expect(getCategoryOutflowBetween(null, "2026-02-01", "2026-03-01", makeDb())).toBe(5000);
  });

  it("includes a categorized transfer leg for a single category (getCategoryStats' ledger view)", () => {
    // The April card payment is a categorized row on the payment category; a
    // single-category query is a ledger of that category, so it counts.
    expect(getCategoryOutflowBetween(CC_PAYMENT, "2026-04-01", "2026-05-01", makeDb())).toBe(12000);
  });

  it("returns 0 for a range with no rows", () => {
    expect(getCategoryOutflowBetween(GROCERIES, "2026-03-01", "2026-04-01", makeDb())).toBe(0);
  });
});

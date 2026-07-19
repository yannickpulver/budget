import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { adjustAssignment, loadBudgetData, SnapshotStore } from "./queries";
import { computePaymentCategoryAdjustments } from "./reconciliation";
import type { CreditCardLink, PlanAvailableEntry } from "./ynab-import";

/**
 * Proves the migration's payment-category reconciliation: given a computed
 * (phantom-inflated) Available for a credit-card payment category and
 * YNAB's own Plan.csv Available for the same month, the adjustment snaps
 * the category to exactly the Plan.csv value and releases the delta to
 * Ready to Assign. Uses the same in-memory SQLite fixture pattern as
 * queries.test.ts (never the real data/budget.db).
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
`;

const CHECKING = 1;
const CREDIT_CARD = 2;
const GROCERIES = 1;
const CARD_PAYMENT = 2;
const MONTH = "2025-01";

function seed() {
  sqlite.exec(DDL);
  sqlite.exec(`
    INSERT INTO accounts (id, name, type, payment_category_id) VALUES
      (${CHECKING}, 'Checking', 'checking', NULL),
      (${CREDIT_CARD}, 'Credit Card', 'credit', ${CARD_PAYMENT});
    INSERT INTO category_groups (id, name, sort, hidden) VALUES
      (10, 'Spending', 0, 0),
      (20, 'Credit Card Payments', 1, 0);
    INSERT INTO categories (id, group_id, name, sort) VALUES
      (${GROCERIES}, 10, 'Groceries', 0),
      (${CARD_PAYMENT}, 20, 'Credit Card', 0);
    -- Income straight to Ready to Assign.
    INSERT INTO transactions (account_id, date, category_id, amount) VALUES
      (${CHECKING}, '${MONTH}-05', NULL, 500000);
    -- Credit-card purchase: feeds Groceries activity and (via YNAB immediate
    -- category funding) the payment category's activity too.
    INSERT INTO transactions (account_id, date, category_id, amount) VALUES
      (${CREDIT_CARD}, '${MONTH}-10', ${GROCERIES}, -20000);
  `);
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  seed();
});

afterEach(() => {
  sqlite.close();
});

describe("payment category reconciliation", () => {
  it("snaps a payment category to the Plan.csv Available and releases the delta to Ready to Assign", () => {
    const store = new SnapshotStore(() => loadBudgetData(makeDb()));

    const before = store.getSnapshot(MONTH);
    const ourAvailable = before.categories.get(CARD_PAYMENT)?.available ?? 0;
    // Immediate category funding from the $200 purchase, no assignment yet.
    expect(ourAvailable).toBe(20000);
    const rtaBefore = before.readyToAssign;

    const creditCardLinks: CreditCardLink[] = [
      { accountName: "Credit Card", paymentGroupName: "Credit Card Payments", paymentCategoryName: "Credit Card" },
    ];
    const categoryIdByKey = new Map<string, number>([["Credit Card Payments::Credit Card", CARD_PAYMENT]]);
    const planAvailable: PlanAvailableEntry[] = [
      {
        month: MONTH,
        groupName: "Credit Card Payments",
        categoryName: "Credit Card",
        assigned: 0,
        activity: 20000,
        available: 5000, // YNAB's ground truth — our replay is phantom-inflated.
      },
    ];

    const adjustments = computePaymentCategoryAdjustments({
      creditCardLinks,
      categoryIdByKey,
      planAvailable,
      ourAvailableAtMonth: new Map([[CARD_PAYMENT, ourAvailable]]),
      month: MONTH,
    });

    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].delta).toBe(5000 - 20000);
    expect(adjustments[0].accountName).toBe("Credit Card");

    adjustAssignment(makeDb(), MONTH, CARD_PAYMENT, adjustments[0].delta);
    store.invalidate();

    const after = store.getSnapshot(MONTH);
    expect(after.categories.get(CARD_PAYMENT)?.available).toBe(5000);
    // Every Rappen removed from the payment category flows straight to RTA.
    expect(after.readyToAssign).toBe(rtaBefore - adjustments[0].delta);
    expect(after.readyToAssign).toBe(rtaBefore + 15000);
  });

  it("produces no adjustment when our Available already matches Plan.csv", () => {
    const creditCardLinks: CreditCardLink[] = [
      { accountName: "Credit Card", paymentGroupName: "Credit Card Payments", paymentCategoryName: "Credit Card" },
    ];
    const categoryIdByKey = new Map<string, number>([["Credit Card Payments::Credit Card", CARD_PAYMENT]]);
    const planAvailable: PlanAvailableEntry[] = [
      {
        month: MONTH,
        groupName: "Credit Card Payments",
        categoryName: "Credit Card",
        assigned: 0,
        activity: 20000,
        available: 20000,
      },
    ];

    const adjustments = computePaymentCategoryAdjustments({
      creditCardLinks,
      categoryIdByKey,
      planAvailable,
      ourAvailableAtMonth: new Map([[CARD_PAYMENT, 20000]]),
      month: MONTH,
    });

    expect(adjustments).toHaveLength(0);
  });

  it("skips a payment category with no Plan.csv entry at the given month", () => {
    const creditCardLinks: CreditCardLink[] = [
      { accountName: "Credit Card", paymentGroupName: "Credit Card Payments", paymentCategoryName: "Credit Card" },
    ];
    const categoryIdByKey = new Map<string, number>([["Credit Card Payments::Credit Card", CARD_PAYMENT]]);

    const adjustments = computePaymentCategoryAdjustments({
      creditCardLinks,
      categoryIdByKey,
      planAvailable: [],
      ourAvailableAtMonth: new Map([[CARD_PAYMENT, 20000]]),
      month: MONTH,
    });

    expect(adjustments).toHaveLength(0);
  });
});

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import {
  createTransaction,
  createTransfer,
  deleteTransaction,
  toggleTransactionCleared,
  updateTransaction,
} from "./queries";

/**
 * Transfer-leg logic against a throwaway in-memory SQLite fixture (never the
 * real data/budget.db), following the pattern in queries.test.ts. The schema
 * has no explicit pair id for transfer legs (per PLAN.md), so creation,
 * edits, and deletes must keep both legs in sync by account/date/amount.
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
const SAVINGS = 2;
const TRACKING = 3;
const GIFTCARD = 4;

const INVESTING = 10;

function seed() {
  sqlite.exec(DDL);
  sqlite.exec(`
    INSERT INTO accounts (id, name, type) VALUES
      (${CHECKING}, 'Checking', 'checking'),
      (${SAVINGS}, 'Savings', 'savings'),
      (${TRACKING}, 'Brokerage', 'tracking'),
      (${GIFTCARD}, 'Amazon Giftcard', 'giftcard');
    INSERT INTO category_groups (id, name) VALUES (1, 'Saving');
    INSERT INTO categories (id, group_id, name) VALUES (${INVESTING}, 1, 'Investing');
  `);
}

function allTransactions() {
  return sqlite.prepare("SELECT * FROM transactions ORDER BY account_id").all() as Array<{
    id: number;
    account_id: number;
    date: string;
    payee: string;
    category_id: number | null;
    memo: string;
    amount: number;
    cleared: number;
    transfer_account_id: number | null;
    transfer_pair_id: string | null;
  }>;
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  seed();
});

afterEach(() => {
  sqlite.close();
});

describe("createTransfer", () => {
  it("creates both legs atomically, linked via transferAccountId, both-on-budget with no category", () => {
    const dbi = makeDb();
    const { fromId, toId } = createTransfer(dbi, {
      fromAccountId: CHECKING,
      toAccountId: SAVINGS,
      date: "2025-03-01",
      amount: 10000,
      memo: "Move to savings",
      cleared: true,
      categoryId: null,
    });

    const rows = allTransactions();
    expect(rows).toHaveLength(2);

    const from = rows.find((r) => r.id === fromId)!;
    const to = rows.find((r) => r.id === toId)!;

    expect(from.account_id).toBe(CHECKING);
    expect(from.amount).toBe(-10000);
    expect(from.transfer_account_id).toBe(SAVINGS);
    expect(from.category_id).toBeNull();

    expect(to.account_id).toBe(SAVINGS);
    expect(to.amount).toBe(10000);
    expect(to.transfer_account_id).toBe(CHECKING);
    expect(to.category_id).toBeNull();

    expect(from.transfer_pair_id).not.toBeNull();
    expect(from.transfer_pair_id).toBe(to.transfer_pair_id);
  });

  it("categorizes only the on-budget leg when the other side is a tracking account", () => {
    const dbi = makeDb();
    createTransfer(dbi, {
      fromAccountId: CHECKING,
      toAccountId: TRACKING,
      date: "2025-03-01",
      amount: 50000,
      memo: "",
      cleared: false,
      categoryId: INVESTING,
    });

    const rows = allTransactions();
    const from = rows.find((r) => r.account_id === CHECKING)!;
    const to = rows.find((r) => r.account_id === TRACKING)!;

    expect(from.category_id).toBe(INVESTING);
    expect(to.category_id).toBeNull();
  });

  it("ignores a supplied category when both sides are on-budget", () => {
    const dbi = makeDb();
    createTransfer(dbi, {
      fromAccountId: CHECKING,
      toAccountId: SAVINGS,
      date: "2025-03-01",
      amount: 100,
      memo: "",
      cleared: false,
      categoryId: INVESTING,
    });

    const rows = allTransactions();
    expect(rows.every((r) => r.category_id === null)).toBe(true);
  });

  it("topping up a giftcard from checking (both on-budget) carries no category on either leg", () => {
    const dbi = makeDb();
    createTransfer(dbi, {
      fromAccountId: CHECKING,
      toAccountId: GIFTCARD,
      date: "2025-03-01",
      amount: 5000,
      memo: "",
      cleared: false,
      categoryId: INVESTING,
    });

    const rows = allTransactions();
    expect(rows.every((r) => r.category_id === null)).toBe(true);
  });

  it("categorizes only the giftcard leg when the other side is a tracking account", () => {
    const dbi = makeDb();
    createTransfer(dbi, {
      fromAccountId: GIFTCARD,
      toAccountId: TRACKING,
      date: "2025-03-01",
      amount: 2500,
      memo: "",
      cleared: false,
      categoryId: INVESTING,
    });

    const rows = allTransactions();
    const from = rows.find((r) => r.account_id === GIFTCARD)!;
    const to = rows.find((r) => r.account_id === TRACKING)!;

    expect(from.category_id).toBe(INVESTING);
    expect(to.category_id).toBeNull();
  });
});

describe("updateTransaction on a transfer leg", () => {
  it("syncs date/memo/amount(negated)/cleared to the mirror leg", () => {
    const dbi = makeDb();
    const { fromId } = createTransfer(dbi, {
      fromAccountId: CHECKING,
      toAccountId: SAVINGS,
      date: "2025-03-01",
      amount: 10000,
      memo: "Move to savings",
      cleared: false,
      categoryId: null,
    });

    updateTransaction(dbi, fromId, {
      date: "2025-03-05",
      payee: "Transfer",
      categoryId: null,
      memo: "Moved more",
      amount: -15000,
      cleared: true,
    });

    const rows = allTransactions();
    const from = rows.find((r) => r.account_id === CHECKING)!;
    const to = rows.find((r) => r.account_id === SAVINGS)!;

    expect(from.amount).toBe(-15000);
    expect(from.date).toBe("2025-03-05");
    expect(from.memo).toBe("Moved more");
    expect(from.cleared).toBe(1);

    expect(to.amount).toBe(15000);
    expect(to.date).toBe("2025-03-05");
    expect(to.memo).toBe("Moved more");
    expect(to.cleared).toBe(1);
  });

  it("does not sync a plain (non-transfer) transaction to anything", () => {
    const dbi = makeDb();
    const id = createTransaction(dbi, {
      accountId: CHECKING,
      date: "2025-03-01",
      payee: "Coffee",
      categoryId: null,
      memo: "",
      amount: -500,
      cleared: false,
    });

    updateTransaction(dbi, id, {
      date: "2025-03-02",
      payee: "Coffee shop",
      categoryId: INVESTING,
      memo: "Latte",
      amount: -650,
      cleared: true,
    });

    const rows = allTransactions();
    expect(rows).toHaveLength(1);
    expect(rows[0].payee).toBe("Coffee shop");
    expect(rows[0].amount).toBe(-650);
    expect(rows[0].category_id).toBe(INVESTING);
  });
});

describe("toggleTransactionCleared on a transfer leg", () => {
  it("flips cleared on both legs together", () => {
    const dbi = makeDb();
    const { fromId } = createTransfer(dbi, {
      fromAccountId: CHECKING,
      toAccountId: SAVINGS,
      date: "2025-03-01",
      amount: 10000,
      memo: "",
      cleared: false,
      categoryId: null,
    });

    toggleTransactionCleared(dbi, fromId);

    const rows = allTransactions();
    expect(rows.every((r) => r.cleared === 1)).toBe(true);

    toggleTransactionCleared(dbi, fromId);
    const rowsAfter = allTransactions();
    expect(rowsAfter.every((r) => r.cleared === 0)).toBe(true);
  });
});

describe("deleteTransaction on a transfer leg", () => {
  it("deletes both legs", () => {
    const dbi = makeDb();
    const { fromId } = createTransfer(dbi, {
      fromAccountId: CHECKING,
      toAccountId: SAVINGS,
      date: "2025-03-01",
      amount: 10000,
      memo: "",
      cleared: false,
      categoryId: null,
    });

    deleteTransaction(dbi, fromId);

    expect(allTransactions()).toHaveLength(0);
  });

  it("deletes only the target when it's a plain transaction", () => {
    const dbi = makeDb();
    const id = createTransaction(dbi, {
      accountId: CHECKING,
      date: "2025-03-01",
      payee: "Coffee",
      categoryId: null,
      memo: "",
      amount: -500,
      cleared: false,
    });
    createTransaction(dbi, {
      accountId: CHECKING,
      date: "2025-03-02",
      payee: "Tea",
      categoryId: null,
      memo: "",
      amount: -300,
      cleared: false,
    });

    deleteTransaction(dbi, id);

    const rows = allTransactions();
    expect(rows).toHaveLength(1);
    expect(rows[0].payee).toBe("Tea");
  });
});

/**
 * Regression coverage for the mirror-leg desync bug: with two same-day,
 * same-amount transfers between the same account pair, the old
 * (account, other account, date, amount) heuristic can't tell the legs
 * apart and may pick the wrong mirror. `transfer_pair_id` (stamped by
 * `createTransfer`) resolves each leg to its own mirror unambiguously.
 */
describe("same-day, same-amount transfers between the same accounts", () => {
  function createAmbiguousPair(dbi: ReturnType<typeof makeDb>) {
    const first = createTransfer(dbi, {
      fromAccountId: CHECKING,
      toAccountId: SAVINGS,
      date: "2025-03-01",
      amount: 10000,
      memo: "First",
      cleared: false,
      categoryId: null,
    });
    const second = createTransfer(dbi, {
      fromAccountId: CHECKING,
      toAccountId: SAVINGS,
      date: "2025-03-01",
      amount: 10000,
      memo: "Second",
      cleared: false,
      categoryId: null,
    });
    return { first, second };
  }

  it("editing leg of #2 updates only #2's mirror, leaving #1 untouched", () => {
    const dbi = makeDb();
    const { first, second } = createAmbiguousPair(dbi);

    updateTransaction(dbi, second.fromId, {
      date: "2025-03-05",
      payee: "Transfer",
      categoryId: null,
      memo: "Second, edited",
      amount: -20000,
      cleared: true,
    });

    const rows = allTransactions();
    const firstFrom = rows.find((r) => r.id === first.fromId)!;
    const firstTo = rows.find((r) => r.id === first.toId)!;
    const secondFrom = rows.find((r) => r.id === second.fromId)!;
    const secondTo = rows.find((r) => r.id === second.toId)!;

    expect(secondFrom.amount).toBe(-20000);
    expect(secondFrom.date).toBe("2025-03-05");
    expect(secondFrom.memo).toBe("Second, edited");
    expect(secondTo.amount).toBe(20000);
    expect(secondTo.date).toBe("2025-03-05");
    expect(secondTo.memo).toBe("Second, edited");

    // #1's legs must be completely unaffected.
    expect(firstFrom.amount).toBe(-10000);
    expect(firstFrom.date).toBe("2025-03-01");
    expect(firstFrom.memo).toBe("First");
    expect(firstTo.amount).toBe(10000);
    expect(firstTo.date).toBe("2025-03-01");
    expect(firstTo.memo).toBe("First");
  });

  it("deleting #2's leg removes only #2's two rows, leaving #1 untouched", () => {
    const dbi = makeDb();
    const { first, second } = createAmbiguousPair(dbi);

    deleteTransaction(dbi, second.fromId);

    const rows = allTransactions();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual([first.fromId, first.toId].sort());
  });

  it("toggling cleared on #2's leg flips only #2's legs, leaving #1's legs untouched", () => {
    const dbi = makeDb();
    const { first, second } = createAmbiguousPair(dbi);

    toggleTransactionCleared(dbi, second.fromId);

    const rows = allTransactions();
    const firstFrom = rows.find((r) => r.id === first.fromId)!;
    const firstTo = rows.find((r) => r.id === first.toId)!;
    const secondFrom = rows.find((r) => r.id === second.fromId)!;
    const secondTo = rows.find((r) => r.id === second.toId)!;

    expect(secondFrom.cleared).toBe(1);
    expect(secondTo.cleared).toBe(1);
    expect(firstFrom.cleared).toBe(0);
    expect(firstTo.cleared).toBe(0);
  });
});

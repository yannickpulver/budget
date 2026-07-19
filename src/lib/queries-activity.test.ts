import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";

/**
 * `getBudgetView`'s per-category `activityTransactions` must always sum to
 * that category's `activity` — including the credit-card payment-category
 * feed (categorized card spend + payment transfers). Exercises the real
 * `getBudgetView` (not just the pure math) against a scratch DB file via
 * `DATABASE_PATH`, the same pattern as `src/app/budget/actions.test.ts`.
 */

let tmpDir: string;
let dbPath: string;
const originalDatabasePath = process.env.DATABASE_PATH;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "newbudget-activity-"));
  dbPath = path.join(tmpDir, "scratch.db");
  process.env.DATABASE_PATH = dbPath;
  vi.resetModules();
});

afterEach(() => {
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sumEntries(entries: { amount: number }[]): number {
  return entries.reduce((total, e) => total + e.amount, 0);
}

describe("getBudgetView activityTransactions", () => {
  it("sums to activity for a plain category and carries date/payee/amount", async () => {
    const { db } = await import("@/db");
    const { getBudgetView } = await import("./queries");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Spending" }).returning().all();
    const [groceries] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Groceries" })
      .returning()
      .all();
    const [checking] = db.insert(schema.accounts).values({ name: "Checking", type: "checking" }).returning().all();

    db.insert(schema.transactions)
      .values([
        { accountId: checking.id, date: "2025-03-05", payee: "Migros", categoryId: groceries.id, amount: -4000 },
        { accountId: checking.id, date: "2025-03-18", payee: "Coop", categoryId: groceries.id, amount: -1500 },
      ])
      .run();

    const view = getBudgetView("2025-03");
    const cat = view.groups.flatMap((g) => g.categories).find((c) => c.id === groceries.id)!;

    expect(cat.activity).toBe(-5500);
    expect(sumEntries(cat.activityTransactions)).toBe(cat.activity);
    expect(cat.activityTransactions).toEqual([
      { id: expect.any(Number), date: "2025-03-05", payee: "Migros", amount: -4000 },
      { id: expect.any(Number), date: "2025-03-18", payee: "Coop", amount: -1500 },
    ]);
  });

  it("mirrors the credit-card payment-category feed: categorized spend + payment transfer legs", async () => {
    const { db } = await import("@/db");
    const { getBudgetView } = await import("./queries");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Spending" }).returning().all();
    const [groceries, cardPayment] = db
      .insert(schema.categories)
      .values([
        { groupId: group.id, name: "Groceries" },
        { groupId: group.id, name: "Credit Card Payment" },
      ])
      .returning()
      .all();
    const [checking] = db.insert(schema.accounts).values({ name: "Checking", type: "checking" }).returning().all();
    const [credit] = db
      .insert(schema.accounts)
      .values({ name: "Visa", type: "credit", paymentCategoryId: cardPayment.id })
      .returning()
      .all();

    // Categorized spend on the credit card: feeds Groceries directly, and
    // feeds the payment category (immediate category funding).
    db.insert(schema.transactions)
      .values({
        accountId: credit.id,
        date: "2025-03-07",
        payee: "Migros",
        categoryId: groceries.id,
        amount: -5000,
      })
      .run();

    // A payment transfer from Checking to the card, reducing the payment
    // category. Both legs share a transferPairId; only the credit leg
    // (categoryId null, transferAccountId -> checking) feeds the category.
    db.insert(schema.transactions)
      .values([
        {
          accountId: checking.id,
          date: "2025-03-20",
          payee: "Transfer",
          amount: -3000,
          transferAccountId: credit.id,
          transferPairId: "pair-1",
        },
        {
          accountId: credit.id,
          date: "2025-03-20",
          payee: "Transfer",
          amount: 3000,
          transferAccountId: checking.id,
          transferPairId: "pair-1",
        },
      ])
      .run();

    const view = getBudgetView("2025-03");
    const cats = view.groups.flatMap((g) => g.categories);
    const groceriesView = cats.find((c) => c.id === groceries.id)!;
    const paymentView = cats.find((c) => c.id === cardPayment.id)!;

    // Groceries: only the categorized spend.
    expect(groceriesView.activity).toBe(-5000);
    expect(sumEntries(groceriesView.activityTransactions)).toBe(groceriesView.activity);

    // Payment category: +5000 (spend feed) - 3000 (payment) = 2000.
    expect(paymentView.activity).toBe(2000);
    expect(sumEntries(paymentView.activityTransactions)).toBe(paymentView.activity);
    expect(paymentView.activityTransactions).toEqual([
      { id: expect.any(Number), date: "2025-03-07", payee: "Migros", amount: 5000 },
      { id: expect.any(Number), date: "2025-03-20", payee: "Payment: Checking", amount: -3000 },
    ]);
  });

  it("shows no transactions for a category untouched this month", async () => {
    const { db } = await import("@/db");
    const { getBudgetView } = await import("./queries");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Spending" }).returning().all();
    const [rent] = db.insert(schema.categories).values({ groupId: group.id, name: "Rent" }).returning().all();

    const view = getBudgetView("2025-03");
    const cat = view.groups.flatMap((g) => g.categories).find((c) => c.id === rent.id)!;

    expect(cat.activity).toBe(0);
    expect(cat.activityTransactions).toEqual([]);
  });
});

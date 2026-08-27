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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-activity-"));
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

describe("getBudgetView avgSpend", () => {
  it("averages net activity over the trailing 6 in-range months, excluding the displayed month; null when untouched", async () => {
    const { db } = await import("@/db");
    const { getBudgetView } = await import("./queries");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Spending" }).returning().all();
    const [groceries, rent] = db
      .insert(schema.categories)
      .values([
        { groupId: group.id, name: "Groceries" },
        { groupId: group.id, name: "Rent" },
      ])
      .returning()
      .all();
    const [checking] = db.insert(schema.accounts).values({ name: "Checking", type: "checking" }).returning().all();

    // Jan-Jun 2025: -1000 (CHF 10) each month in Groceries; earliestMonth = 2025-01,
    // and the displayed month (2025-07) has a large spend that must NOT count.
    db.insert(schema.transactions)
      .values(
        ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06"].map((month) => ({
          accountId: checking.id,
          date: `${month}-10`,
          payee: "Migros",
          categoryId: groceries.id,
          amount: -1000,
        }))
      )
      .run();
    db.insert(schema.transactions)
      .values({
        accountId: checking.id,
        date: "2025-07-05",
        payee: "Migros",
        categoryId: groceries.id,
        amount: -50000,
      })
      .run();

    const view = getBudgetView("2025-07");
    const cats = view.groups.flatMap((g) => g.categories);
    const groceriesView = cats.find((c) => c.id === groceries.id)!;
    const rentView = cats.find((c) => c.id === rent.id)!;

    // Mean of six -1000 months = -1000 -> magnitude 1000, unaffected by July's spend.
    expect(groceriesView.avgSpend).toBe(1000);
    // Never touched -> average is 0 -> hidden.
    expect(rentView.avgSpend).toBeNull();
  });

  it("skips credit-card payment categories even when they have activity in the window", async () => {
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
    const [credit] = db
      .insert(schema.accounts)
      .values({ name: "Visa", type: "credit", paymentCategoryId: cardPayment.id })
      .returning()
      .all();

    db.insert(schema.transactions)
      .values(
        ["2025-01", "2025-02", "2025-03"].map((month) => ({
          accountId: credit.id,
          date: `${month}-10`,
          payee: "Migros",
          categoryId: groceries.id,
          amount: -2000,
        }))
      )
      .run();

    const view = getBudgetView("2025-07");
    const cats = view.groups.flatMap((g) => g.categories);
    const groceriesView = cats.find((c) => c.id === groceries.id)!;
    const paymentView = cats.find((c) => c.id === cardPayment.id)!;

    expect(groceriesView.avgSpend).not.toBeNull();
    expect(paymentView.avgSpend).toBeNull();
  });
});

describe("getBudgetView goals start month", () => {
  it("suppresses goal/underfunded status before goalsStartMonth, applies it at/after", async () => {
    const { db } = await import("@/db");
    const { getBudgetView, setGoalsStartMonth, invalidateBudgetCache } = await import("./queries");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Spending" }).returning().all();
    const [groceries] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Groceries", monthlyTarget: 20000 })
      .returning()
      .all();
    db.insert(schema.accounts).values({ name: "Checking", type: "checking" }).run();

    setGoalsStartMonth(db, "2026-07");
    invalidateBudgetCache();

    const before = getBudgetView("2026-06").groups.flatMap((g) => g.categories).find((c) => c.id === groceries.id)!;
    expect(before.monthlyTarget).toBeNull();
    expect(before.goal).toBeNull();
    expect(before.underfunded).toBe(false);
    expect(before.goalFunded).toBe(false);

    for (const month of ["2026-07", "2026-08"]) {
      const view = getBudgetView(month).groups.flatMap((g) => g.categories).find((c) => c.id === groceries.id)!;
      expect(view.monthlyTarget).toBe(20000);
      expect(view.goal).not.toBeNull();
      expect(view.underfunded).toBe(true);
    }
  });
});

describe("getBudgetView hiddenFrom", () => {
  it("shows a category for months before hiddenFrom and hides it from that month on", async () => {
    const { db } = await import("@/db");
    const { getBudgetView } = await import("./queries");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Saving" }).returning().all();
    const [trip] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Trip", hiddenFrom: "2026-08" })
      .returning()
      .all();

    for (const month of ["2026-06", "2026-07"]) {
      const cats = getBudgetView(month).groups.flatMap((g) => g.categories);
      expect(cats.some((c) => c.id === trip.id)).toBe(true);
    }
    for (const month of ["2026-08", "2026-09"]) {
      const cats = getBudgetView(month).groups.flatMap((g) => g.categories);
      expect(cats.some((c) => c.id === trip.id)).toBe(false);
    }
  });
});

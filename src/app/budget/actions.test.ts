import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";

// The "valid amount" cases below exercise the full action, including its
// cache-refresh step — `revalidatePath` requires a live Next.js request
// context that doesn't exist under Vitest, so it's stubbed out here. The
// guard behavior under test never depends on it.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * Regression coverage for the numeric guard on budget server actions:
 * `setAssigned`/`setMonthlyTarget` must reject non-finite (NaN/Infinity) or
 * absurd (|amount| > 1e13) values before writing, rather than letting a bad
 * request corrupt the assignments/categories tables. Uses a scratch DB via
 * `DATABASE_PATH` (never the real data/budget.db) — see the pattern in
 * `src/db/bootstrap.test.ts`.
 */

let tmpDir: string;
let dbPath: string;
const originalDatabasePath = process.env.DATABASE_PATH;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-budget-actions-"));
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

const BAD_AMOUNTS = [NaN, Infinity, -Infinity, 2e13, -2e13];

describe("setAssigned", () => {
  it("rejects non-finite/absurd amounts, writing no assignment row", async () => {
    const { db } = await import("@/db");
    const { setAssigned } = await import("./actions");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Spending" }).returning().all();
    const [category] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Groceries" })
      .returning()
      .all();

    for (const amount of BAD_AMOUNTS) {
      await setAssigned("2025-01", category.id, amount);
    }

    const rows = db.select().from(schema.assignments).all();
    expect(rows).toHaveLength(0);
  });

  it("still accepts an ordinary amount (guard isn't over-broad)", async () => {
    const { db } = await import("@/db");
    const { setAssigned } = await import("./actions");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Spending" }).returning().all();
    const [category] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Groceries" })
      .returning()
      .all();

    await setAssigned("2025-01", category.id, 12345);

    const row = db.select().from(schema.assignments).get();
    expect(row?.amount).toBe(12345);
  });
});

describe("moveMoney", () => {
  it("moves money between two categories in one transaction", async () => {
    const { db } = await import("@/db");
    const { moveMoney } = await import("./actions");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Spending" }).returning().all();
    const [from] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Groceries" })
      .returning()
      .all();
    const [to] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Dining" })
      .returning()
      .all();
    db.insert(schema.assignments).values({ month: "2025-01", categoryId: from.id, amount: 10000 }).run();

    await moveMoney("2025-01", from.id, to.id, 4000);

    const rows = db.select().from(schema.assignments).all();
    expect(rows.find((r) => r.categoryId === from.id)?.amount).toBe(6000);
    expect(rows.find((r) => r.categoryId === to.id)?.amount).toBe(4000);
  });

  it("skips the source adjustment when moving from Ready to Assign", async () => {
    const { db } = await import("@/db");
    const { moveMoney } = await import("./actions");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Spending" }).returning().all();
    const [to] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Dining" })
      .returning()
      .all();

    await moveMoney("2025-01", null, to.id, 4000);

    const rows = db.select().from(schema.assignments).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.categoryId).toBe(to.id);
    expect(rows[0]?.amount).toBe(4000);
  });

  it("skips the destination adjustment when moving to Ready to Assign", async () => {
    const { db } = await import("@/db");
    const { moveMoney } = await import("./actions");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Spending" }).returning().all();
    const [from] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Groceries" })
      .returning()
      .all();
    db.insert(schema.assignments).values({ month: "2025-01", categoryId: from.id, amount: 10000 }).run();

    await moveMoney("2025-01", from.id, null, 4000);

    const rows = db.select().from(schema.assignments).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.categoryId).toBe(from.id);
    expect(rows[0]?.amount).toBe(6000);
  });

  it("rejects a non-positive amount, writing nothing", async () => {
    const { db } = await import("@/db");
    const { moveMoney } = await import("./actions");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Spending" }).returning().all();
    const [from] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Groceries" })
      .returning()
      .all();
    const [to] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Dining" })
      .returning()
      .all();

    for (const amount of [0, -1, ...BAD_AMOUNTS]) {
      await moveMoney("2025-01", from.id, to.id, amount);
    }

    expect(db.select().from(schema.assignments).all()).toHaveLength(0);
  });

  it("rejects moving a category to itself, including RTA-to-RTA", async () => {
    const { db } = await import("@/db");
    const { moveMoney } = await import("./actions");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Spending" }).returning().all();
    const [category] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Groceries" })
      .returning()
      .all();

    await moveMoney("2025-01", category.id, category.id, 1000);
    await moveMoney("2025-01", null, null, 1000);

    expect(db.select().from(schema.assignments).all()).toHaveLength(0);
  });
});

describe("setMonthlyTarget", () => {
  it("rejects non-finite/absurd targets, leaving the category's target unchanged", async () => {
    const { db } = await import("@/db");
    const { setMonthlyTarget } = await import("./actions");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Bills" }).returning().all();
    const [category] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Rent", monthlyTarget: 150000 })
      .returning()
      .all();

    for (const amount of BAD_AMOUNTS) {
      await setMonthlyTarget(category.id, amount);
    }

    const row = db.select().from(schema.categories).where(eq(schema.categories.id, category.id)).get();
    expect(row?.monthlyTarget).toBe(150000);
  });

  it("still accepts clearing the target (null) and an ordinary target", async () => {
    const { db } = await import("@/db");
    const { setMonthlyTarget } = await import("./actions");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Bills" }).returning().all();
    const [category] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Rent", monthlyTarget: 150000 })
      .returning()
      .all();

    await setMonthlyTarget(category.id, null);
    expect(
      db.select().from(schema.categories).where(eq(schema.categories.id, category.id)).get()?.monthlyTarget
    ).toBeNull();

    await setMonthlyTarget(category.id, 90000);
    expect(
      db.select().from(schema.categories).where(eq(schema.categories.id, category.id)).get()?.monthlyTarget
    ).toBe(90000);
  });
});

describe("closeCategory", () => {
  it("releases Available back to RTA, clears the target, and hides the category from this month on", async () => {
    const { db } = await import("@/db");
    const { closeCategory } = await import("./actions");
    const { currentMonth } = await import("@/lib/queries");
    const month = currentMonth();

    const [group] = db.insert(schema.categoryGroups).values({ name: "Saving" }).returning().all();
    const [category] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Trip", monthlyTarget: 200000, targetType: "balance", targetDate: "2025-12" })
      .returning()
      .all();
    db.insert(schema.assignments).values({ month, categoryId: category.id, amount: 5000 }).run();

    await closeCategory(month, category.id);

    const row = db.select().from(schema.categories).where(eq(schema.categories.id, category.id)).get();
    expect(row?.hiddenFrom).toBe(month);
    expect(row?.monthlyTarget).toBeNull();
    expect(row?.targetType).toBe("monthly");
    expect(row?.targetDate).toBeNull();
    // The 5000 that was Available is un-assigned (released to Ready to Assign).
    const assignment = db.select().from(schema.assignments).all().find((r) => r.categoryId === category.id);
    expect(assignment?.amount).toBe(0);
  });

  it("is a no-op from a month that isn't the current month", async () => {
    const { db } = await import("@/db");
    const { closeCategory } = await import("./actions");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Saving" }).returning().all();
    const [category] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Trip" })
      .returning()
      .all();
    db.insert(schema.assignments).values({ month: "2020-01", categoryId: category.id, amount: 5000 }).run();

    await closeCategory("2020-01", category.id);

    const row = db.select().from(schema.categories).where(eq(schema.categories.id, category.id)).get();
    expect(row?.hiddenFrom).toBeNull();
    const assignment = db.select().from(schema.assignments).all().find((r) => r.categoryId === category.id);
    expect(assignment?.amount).toBe(5000);
  });

  it("is a no-op when Available is negative (overspent)", async () => {
    const { db } = await import("@/db");
    const { closeCategory } = await import("./actions");
    const { currentMonth } = await import("@/lib/queries");
    const month = currentMonth();

    const [account] = db.insert(schema.accounts).values({ name: "Checking", type: "checking" }).returning().all();
    const [group] = db.insert(schema.categoryGroups).values({ name: "Saving" }).returning().all();
    const [category] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Trip" })
      .returning()
      .all();
    // Spend with nothing assigned drives Available negative.
    db.insert(schema.transactions)
      .values({ accountId: account.id, date: `${month}-15`, payee: "Shop", categoryId: category.id, amount: -5000, cleared: true })
      .run();

    await closeCategory(month, category.id);

    const row = db.select().from(schema.categories).where(eq(schema.categories.id, category.id)).get();
    expect(row?.hiddenFrom).toBeNull();
  });
});

describe("hideCategoryFromMonth", () => {
  it("releases positive Available back to Ready to Assign for the current month, keeping the goal intact", async () => {
    const { db } = await import("@/db");
    const { hideCategoryFromMonth } = await import("./actions");
    const { currentMonth, getBudgetView } = await import("@/lib/queries");
    const month = currentMonth();

    const [group] = db.insert(schema.categoryGroups).values({ name: "Saving" }).returning().all();
    const [category] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Trip", monthlyTarget: 200000 })
      .returning()
      .all();
    db.insert(schema.assignments).values({ month, categoryId: category.id, amount: 5000 }).run();

    const rtaBefore = getBudgetView(month).readyToAssign;

    await hideCategoryFromMonth(month, category.id);

    const row = db.select().from(schema.categories).where(eq(schema.categories.id, category.id)).get();
    expect(row?.hiddenFrom).toBe(month);
    // Unlike closeCategory, the goal survives — hiding isn't "this is finished".
    expect(row?.monthlyTarget).toBe(200000);
    const assignment = db.select().from(schema.assignments).all().find((r) => r.categoryId === category.id);
    expect(assignment?.amount).toBe(0);
    expect(getBudgetView(month).readyToAssign).toBe(rtaBefore + 5000);
  });

  it("moves nothing and just hides for a month that isn't the current month", async () => {
    const { db } = await import("@/db");
    const { hideCategoryFromMonth } = await import("./actions");

    const [group] = db.insert(schema.categoryGroups).values({ name: "Saving" }).returning().all();
    const [category] = db
      .insert(schema.categories)
      .values({ groupId: group.id, name: "Trip" })
      .returning()
      .all();
    db.insert(schema.assignments).values({ month: "2020-01", categoryId: category.id, amount: 5000 }).run();

    await hideCategoryFromMonth("2020-01", category.id);

    const row = db.select().from(schema.categories).where(eq(schema.categories.id, category.id)).get();
    expect(row?.hiddenFrom).toBe("2020-01");
    const assignment = db.select().from(schema.assignments).all().find((r) => r.categoryId === category.id);
    expect(assignment?.amount).toBe(5000);
  });
});

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "newbudget-budget-actions-"));
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the numeric guard on holdings server actions:
 * `createHoldingAction`/`updateHoldingAction` must reject a non-finite
 * (NaN/Infinity) or absurd (|quantity| > 1e13) quantity before writing.
 * Uses a scratch DB via `DATABASE_PATH` (never the real data/budget.db) —
 * see the pattern in `src/db/bootstrap.test.ts`.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let tmpDir: string;
let dbPath: string;
const originalDatabasePath = process.env.DATABASE_PATH;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-holdings-actions-"));
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

const BAD_QUANTITIES = [NaN, Infinity, -Infinity, 2e13];

async function seedTrackingAccount() {
  const { db } = await import("@/db");
  const { createAccount } = await import("@/lib/queries");
  const accountId = createAccount(db, { name: "Brokerage", type: "tracking", startingBalance: 0, date: "2025-01-01" });
  return { db, accountId };
}

describe("createHoldingAction", () => {
  it("rejects a non-finite or absurd quantity, writing nothing", async () => {
    const { db, accountId } = await seedTrackingAccount();
    const { createHoldingAction } = await import("./holdings-actions");
    const schema = await import("@/db/schema");

    for (const quantity of BAD_QUANTITIES) {
      const result = await createHoldingAction(accountId, { symbol: "VOO", name: "", quantity });
      expect(result.ok).toBe(false);
    }

    expect(db.select().from(schema.holdings).all()).toHaveLength(0);
  });

  it("still accepts an ordinary quantity", async () => {
    const { accountId } = await seedTrackingAccount();
    const { createHoldingAction } = await import("./holdings-actions");

    const result = await createHoldingAction(accountId, { symbol: "VOO", name: "", quantity: 10 });
    expect(result).toEqual({ ok: true });
  });
});

describe("updateHoldingAction", () => {
  it("rejects a non-finite or absurd quantity, leaving the holding unchanged", async () => {
    const { db, accountId } = await seedTrackingAccount();
    const { createHoldingAction, updateHoldingAction } = await import("./holdings-actions");
    const schema = await import("@/db/schema");

    await createHoldingAction(accountId, { symbol: "VOO", name: "", quantity: 10 });
    const before = db.select().from(schema.holdings).get()!;

    for (const quantity of BAD_QUANTITIES) {
      const result = await updateHoldingAction(before.id, accountId, { symbol: "VOO", name: "", quantity });
      expect(result.ok).toBe(false);
    }

    const after = db.select().from(schema.holdings).get()!;
    expect(after.quantity).toBe(before.quantity);
  });
});

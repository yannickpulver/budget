import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the numeric guard on the account/transaction
 * server actions: `createTransactionAction`, `updateTransactionAction`, and
 * `createTransferAction` must reject non-finite (NaN/Infinity) or absurd
 * (|amount| > 1e13) amounts before writing. Uses a scratch DB via
 * `DATABASE_PATH` (never the real data/budget.db) — see the pattern in
 * `src/db/bootstrap.test.ts`.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let tmpDir: string;
let dbPath: string;
const originalDatabasePath = process.env.DATABASE_PATH;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "newbudget-account-actions-"));
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

async function seedTwoAccounts() {
  const { db } = await import("@/db");
  const { createAccount } = await import("@/lib/queries");
  const a = createAccount(db, { name: "Checking", type: "checking", startingBalance: 0, date: "2025-01-01" });
  const b = createAccount(db, { name: "Savings", type: "savings", startingBalance: 0, date: "2025-01-01" });
  return { db, a, b };
}

describe("createTransactionAction", () => {
  it("rejects non-finite/absurd amounts with an error, writing nothing", async () => {
    const { db, a } = await seedTwoAccounts();
    const { createTransactionAction } = await import("./actions");
    const schema = await import("@/db/schema");

    for (const amount of BAD_AMOUNTS) {
      const result = await createTransactionAction({
        accountId: a,
        date: "2025-01-05",
        payee: "Test",
        memo: "",
        cleared: true,
        amount,
        categoryId: null,
      });
      expect(result).toEqual({ ok: false, error: "Amount is not a valid number." });
    }

    expect(db.select().from(schema.transactions).all()).toHaveLength(0);
  });

  it("still accepts an ordinary amount", async () => {
    const { a } = await seedTwoAccounts();
    const { createTransactionAction } = await import("./actions");

    const result = await createTransactionAction({
      accountId: a,
      date: "2025-01-05",
      payee: "Test",
      memo: "",
      cleared: true,
      amount: -4250,
      categoryId: null,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("createTransferAction", () => {
  it("rejects non-finite/absurd amounts with an error, writing nothing", async () => {
    const { db, a, b } = await seedTwoAccounts();
    const { createTransferAction } = await import("./actions");
    const schema = await import("@/db/schema");

    for (const amount of BAD_AMOUNTS) {
      const result = await createTransferAction({
        fromAccountId: a,
        toAccountId: b,
        date: "2025-01-05",
        amount,
        memo: "",
        cleared: true,
        categoryId: null,
      });
      expect(result).toEqual({ ok: false, error: "Amount is not a valid number." });
    }

    expect(db.select().from(schema.transactions).all()).toHaveLength(0);
  });
});

describe("updateTransactionAction", () => {
  it("rejects non-finite/absurd amounts with an error, leaving the transaction unchanged", async () => {
    const { db, a } = await seedTwoAccounts();
    const { createTransactionAction, updateTransactionAction } = await import("./actions");
    const schema = await import("@/db/schema");

    await createTransactionAction({
      accountId: a,
      date: "2025-01-05",
      payee: "Original",
      memo: "",
      cleared: true,
      amount: -1000,
      categoryId: null,
    });
    const before = db.select().from(schema.transactions).get()!;

    for (const amount of BAD_AMOUNTS) {
      const result = await updateTransactionAction(before.id, a, null, {
        date: "2025-01-06",
        payee: "Changed",
        memo: "",
        cleared: true,
        amount,
        categoryId: null,
      });
      expect(result).toEqual({ ok: false, error: "Amount is not a valid number." });
    }

    const after = db.select().from(schema.transactions).get()!;
    expect(after).toEqual(before);
  });
});

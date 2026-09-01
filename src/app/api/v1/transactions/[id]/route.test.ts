import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Covers `/api/v1/transactions/:id` against a scratch DB — a PATCH touches
 * only the fields it names, `categoryId: null` clears the category while an
 * absent one keeps it, and a transfer leg's amount edit reaches the mirror
 * leg. Follows the scratch-DB pattern in `../route.test.ts`.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let tmpDir: string;
let dbPath: string;
const originalDatabasePath = process.env.DATABASE_PATH;
const originalApiToken = process.env.API_TOKEN;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-api-v1-transaction-"));
  dbPath = path.join(tmpDir, "scratch.db");
  process.env.DATABASE_PATH = dbPath;
  process.env.API_TOKEN = "test-token";
  vi.resetModules();
});

afterEach(() => {
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
  if (originalApiToken === undefined) delete process.env.API_TOKEN;
  else process.env.API_TOKEN = originalApiToken;
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seed() {
  const { db } = await import("@/db");
  const q = await import("@/lib/queries");
  const account = q.createAccount(db, { name: "Checking", type: "checking", startingBalance: 0, date: "2025-01-01" });
  const other = q.createAccount(db, { name: "Savings", type: "savings", startingBalance: 0, date: "2025-01-01" });
  const group = q.createCategoryGroup(db, "Spending");
  const category = q.createCategory(db, group, "Groceries");
  const id = q.createTransaction(db, {
    accountId: account,
    date: "2025-01-05",
    payee: "Backblaze",
    categoryId: category,
    memo: "annual",
    amount: -339,
    cleared: true,
  });
  return { db, q, account, other, category, id };
}

function patchReq(id: number, body: unknown, token = "test-token"): Request {
  return new Request(`http://localhost/api/v1/transactions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function params(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) };
}

describe("GET /api/v1/transactions/:id", () => {
  it("rejects a request with no token", async () => {
    const { id } = await seed();
    const { GET } = await import("./route");

    const res = await GET(new Request(`http://localhost/api/v1/transactions/${id}`), params(id));

    expect(res.status).toBe(401);
  });

  it("returns the row with its account, category and transfer names", async () => {
    const { id, account } = await seed();
    const { GET } = await import("./route");

    const res = await GET(
      new Request(`http://localhost/api/v1/transactions/${id}`, { headers: { authorization: "Bearer test-token" } }),
      params(id)
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id,
      accountId: account,
      accountName: "Checking",
      date: "2025-01-05",
      payee: "Backblaze",
      memo: "annual",
      amount: -339,
      cleared: true,
      categoryId: expect.any(Number),
      categoryName: "Groceries",
      transferAccountId: null,
      transferAccountName: null,
    });
  });

  it("404s on an unknown id", async () => {
    await seed();
    const { GET } = await import("./route");

    const res = await GET(
      new Request("http://localhost/api/v1/transactions/9999", { headers: { authorization: "Bearer test-token" } }),
      params(9999)
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Transaction not found" });
  });
});

describe("PATCH /api/v1/transactions/:id", () => {
  it("changes only the named field, keeping every other value", async () => {
    const { db, q, id, category } = await seed();
    const { PATCH } = await import("./route");

    const res = await PATCH(patchReq(id, { amount: -340 }), params(id));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(q.getTransactionById(id, db)).toMatchObject({
      date: "2025-01-05",
      payee: "Backblaze",
      memo: "annual",
      amount: -340,
      cleared: true,
      categoryId: category,
    });
  });

  it("clears the category on an explicit null and keeps it when absent", async () => {
    const { db, q, id, category } = await seed();
    const { PATCH } = await import("./route");

    expect((await PATCH(patchReq(id, { payee: "Renamed" }), params(id))).status).toBe(200);
    expect(q.getTransactionById(id, db)).toMatchObject({ payee: "Renamed", categoryId: category });

    expect((await PATCH(patchReq(id, { categoryId: null }), params(id))).status).toBe(200);
    expect(q.getTransactionById(id, db)).toMatchObject({ payee: "Renamed", categoryId: null, categoryName: null });
  });

  it("rejects a body with no updatable fields", async () => {
    const { id } = await seed();
    const { PATCH } = await import("./route");

    const res = await PATCH(patchReq(id, { nope: 1 }), params(id));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No fields to update." });
  });

  it("rejects a wrongly typed field", async () => {
    const { id } = await seed();
    const { PATCH } = await import("./route");

    const res = await PATCH(patchReq(id, { amount: "-3.40" }), params(id));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request body." });
  });

  it("404s on an unknown id, writing nothing", async () => {
    const { db, q, id } = await seed();
    const { PATCH } = await import("./route");

    const res = await PATCH(patchReq(9999, { amount: -1 }), params(9999));

    expect(res.status).toBe(404);
    expect(q.getTransactionById(id, db)?.amount).toBe(-339);
  });

  it("surfaces the action's validation error for a zero amount", async () => {
    const { id } = await seed();
    const { PATCH } = await import("./route");

    const res = await PATCH(patchReq(id, { amount: 0 }), params(id));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Enter an outflow or inflow amount." });
  });

  it("rejects a request with no token, writing nothing", async () => {
    const { db, q, id } = await seed();
    const { PATCH } = await import("./route");

    const res = await PATCH(patchReq(id, { amount: -340 }, ""), params(id));

    expect(res.status).toBe(401);
    expect(q.getTransactionById(id, db)?.amount).toBe(-339);
  });

  it("applies a falsy cleared, memo and payee rather than falling back to the old value", async () => {
    const { db, q, id } = await seed();
    const { PATCH } = await import("./route");

    expect((await PATCH(patchReq(id, { cleared: false }), params(id))).status).toBe(200);
    expect(q.getTransactionById(id, db)?.cleared).toBe(false);

    expect((await PATCH(patchReq(id, { memo: "" }), params(id))).status).toBe(200);
    expect(q.getTransactionById(id, db)?.memo).toBe("");

    expect((await PATCH(patchReq(id, { payee: "" }), params(id))).status).toBe(200);
    expect(q.getTransactionById(id, db)?.payee).toBe("");
  });

  it("surfaces the action's validation error for a malformed date, writing nothing", async () => {
    const { db, q, id } = await seed();
    const { PATCH } = await import("./route");

    const res = await PATCH(patchReq(id, { date: "not-a-date" }), params(id));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid date (expected YYYY-MM-DD)." });
    expect(q.getTransactionById(id, db)?.date).toBe("2025-01-05");
  });

  it("refuses to change a transfer leg's payee, which the DB would silently ignore", async () => {
    const { db, q, account, other } = await seed();
    const { fromId } = q.createTransfer(db, {
      fromAccountId: account,
      toAccountId: other,
      date: "2025-01-06",
      amount: 5000,
      memo: "",
      cleared: false,
      categoryId: null,
    });
    const { PATCH } = await import("./route");

    const res = await PATCH(patchReq(fromId, { payee: "Rent" }), params(fromId));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Cannot change a transfer's payee." });
  });

  it("syncs a transfer leg's amount to its mirror leg", async () => {
    const { db, q, account, other } = await seed();
    const { fromId, toId } = q.createTransfer(db, {
      fromAccountId: account,
      toAccountId: other,
      date: "2025-01-06",
      amount: 5000,
      memo: "",
      cleared: false,
      categoryId: null,
    });
    const { PATCH } = await import("./route");

    const res = await PATCH(patchReq(fromId, { amount: -7500 }), params(fromId));

    expect(res.status).toBe(200);
    expect(q.getTransactionById(fromId, db)?.amount).toBe(-7500);
    expect(q.getTransactionById(toId, db)?.amount).toBe(7500);
  });
});

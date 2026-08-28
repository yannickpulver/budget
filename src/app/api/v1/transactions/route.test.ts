import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Covers the `/api/v1/transactions` route end to end against a scratch DB —
 * auth is enforced, a valid POST is readable back via the account
 * transactions route, and the underlying action's validation errors surface
 * as a 400. Follows the scratch-DB pattern in `src/app/accounts/actions.test.ts`.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let tmpDir: string;
let dbPath: string;
const originalDatabasePath = process.env.DATABASE_PATH;
const originalApiToken = process.env.API_TOKEN;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-api-v1-transactions-"));
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

async function seedAccount() {
  const { db } = await import("@/db");
  const { createAccount } = await import("@/lib/queries");
  const a = createAccount(db, { name: "Checking", type: "checking", startingBalance: 0, date: "2025-01-01" });
  return { db, a };
}

function postReq(body: unknown, token?: string): Request {
  return new Request("http://localhost/api/v1/transactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/transactions", () => {
  it("rejects a request with no token, writing nothing", async () => {
    const { db, a } = await seedAccount();
    const schema = await import("@/db/schema");
    const { POST } = await import("./route");

    const res = await POST(
      postReq({ accountId: a, date: "2025-01-05", payee: "Test", memo: "", cleared: true, amount: -1250, categoryId: null })
    );

    expect(res.status).toBe(401);
    expect(db.select().from(schema.transactions).all()).toHaveLength(0);
  });

  it("creates a transaction, readable back via the account transactions route", async () => {
    const { a } = await seedAccount();
    const { POST } = await import("./route");

    const res = await POST(
      postReq(
        { accountId: a, date: "2025-01-05", payee: "Test", memo: "", cleared: true, amount: -1250, categoryId: null },
        "test-token"
      )
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const { GET } = await import("../accounts/[id]/transactions/route");
    const getRes = await GET(
      new Request("http://localhost/api/v1/accounts/1/transactions", {
        headers: { authorization: "Bearer test-token" },
      }),
      { params: Promise.resolve({ id: String(a) }) }
    );

    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { rows: { amount: number }[] };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].amount).toBe(-1250);
  });

  it("returns the action's validation error for a zero amount", async () => {
    const { a } = await seedAccount();
    const { POST } = await import("./route");

    const res = await POST(
      postReq(
        { accountId: a, date: "2025-01-05", payee: "Test", memo: "", cleared: true, amount: 0, categoryId: null },
        "test-token"
      )
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Enter an outflow or inflow amount." });
  });

  it("rejects a malformed date, writing nothing", async () => {
    const { db, a } = await seedAccount();
    const schema = await import("@/db/schema");
    const { POST } = await import("./route");

    const res = await POST(
      postReq(
        { accountId: a, date: "01.03.2025", payee: "Test", memo: "", cleared: true, amount: -1250, categoryId: null },
        "test-token"
      )
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid date (expected YYYY-MM-DD)." });
    expect(db.select().from(schema.transactions).all()).toHaveLength(0);
  });
});

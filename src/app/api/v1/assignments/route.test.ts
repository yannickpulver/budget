import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Covers `/api/v1/assignments` against a scratch DB: auth is enforced, money
 * moves from Ready to Assign or from another category, bad input writes
 * nothing, and the move is one undo step.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let tmpDir: string;
const originalDatabasePath = process.env.DATABASE_PATH;
const originalApiToken = process.env.API_TOKEN;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-api-v1-assignments-"));
  process.env.DATABASE_PATH = path.join(tmpDir, "scratch.db");
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
  const schema = await import("@/db/schema");
  const [group] = db.insert(schema.categoryGroups).values({ name: "Spending" }).returning().all();
  const [groceries, transport] = db
    .insert(schema.categories)
    .values([
      { groupId: group.id, name: "Groceries" },
      { groupId: group.id, name: "Transport" },
    ])
    .returning()
    .all();
  const assigned = () =>
    Object.fromEntries(db.select().from(schema.assignments).all().map((row) => [row.categoryId, row.amount]));
  return { groceries: groceries.id, transport: transport.id, assigned };
}

function postReq(body: unknown, token: string | null = "test-token"): Request {
  return new Request("http://localhost/api/v1/assignments", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/assignments", () => {
  it("rejects a request with no token, writing nothing", async () => {
    const { groceries, assigned } = await seed();
    const { POST } = await import("./route");

    const res = await POST(postReq({ month: "2025-01", categoryId: groceries, amount: 1000 }, null));

    expect(res.status).toBe(401);
    expect(assigned()).toEqual({});
  });

  it("adds to a category's assignment from Ready to Assign, on top of what's there", async () => {
    const { groceries, assigned } = await seed();
    const { POST } = await import("./route");

    expect((await POST(postReq({ month: "2025-01", categoryId: groceries, amount: 1000 }))).status).toBe(200);
    expect((await POST(postReq({ month: "2025-01", categoryId: groceries, amount: 250 }))).status).toBe(200);

    expect(assigned()).toEqual({ [groceries]: 1250 });
  });

  it("moves money from another category", async () => {
    const { groceries, transport, assigned } = await seed();
    const { POST } = await import("./route");

    await POST(postReq({ month: "2025-01", categoryId: groceries, amount: 1000 }));
    const res = await POST(postReq({ month: "2025-01", categoryId: transport, fromCategoryId: groceries, amount: 400 }));

    expect(res.status).toBe(200);
    expect(assigned()).toEqual({ [groceries]: 600, [transport]: 400 });
  });

  it.each([
    ["a bad month", { month: "2025-13", amount: 1000 }],
    ["a zero amount", { month: "2025-01", amount: 0 }],
    ["a negative amount", { month: "2025-01", amount: -500 }],
    ["a fractional amount", { month: "2025-01", amount: 10.5 }],
    ["an unknown category", { month: "2025-01", amount: 1000, categoryId: 9999 }],
    ["an unknown source category", { month: "2025-01", amount: 1000, fromCategoryId: 9999 }],
    ["the same source and target", { month: "2025-01", amount: 1000, fromCategoryId: "self" }],
  ])("rejects %s with a 400, writing nothing", async (_label, body) => {
    const { groceries, assigned } = await seed();
    const { POST } = await import("./route");

    const payload = { categoryId: groceries, ...body } as Record<string, unknown>;
    if (payload.fromCategoryId === "self") payload.fromCategoryId = groceries;
    const res = await POST(postReq(payload));

    expect(res.status).toBe(400);
    expect(assigned()).toEqual({});
  });

  it("is reversed by a single undo", async () => {
    const { groceries, assigned } = await seed();
    const { POST } = await import("./route");
    const { POST: undo } = await import("../undo/route");

    await POST(postReq({ month: "2025-01", categoryId: groceries, amount: 1000 }));
    const res = await undo(new Request("http://localhost/api/v1/undo", { method: "POST", headers: { authorization: "Bearer test-token" } }));

    expect(await res.json()).toMatchObject({ ok: true, label: "Move money" });
    expect(assigned()).toEqual({});
  });
});

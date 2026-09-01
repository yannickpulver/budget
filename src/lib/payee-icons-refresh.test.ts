import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";

/**
 * Selection tests for `refreshPayeeIcons` — which payees a run picks up and
 * which it skips. The network download itself is stubbed out (see
 * payee-icons.test.ts for the pure helpers), so what is exercised here is the
 * candidate list, the "ok"/"none" skip rules and the per-run fetch budget.
 */

let sqlite: Database.Database;
let tmpDir: string;

const DDL = `
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
CREATE TABLE payee_icons (
  payee TEXT PRIMARY KEY,
  domain TEXT,
  status TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
`;

// Icons land next to the database; point that at a throwaway directory.
vi.mock("@/db/paths", () => ({ dataDir: () => process.env.TEST_ICON_DIR as string }));
vi.mock("@/db", () => ({ db: {} }));

const { getIconPayees } = await import("./queries");
const { refreshPayeeIcons } = await import("./payee-icons");

function makeDb() {
  return drizzle(sqlite, { schema });
}

/** Insert a transaction for `payee` on `date`. */
function tx(payee: string, date: string, transferAccountId: number | null = null) {
  sqlite
    .prepare(
      "INSERT INTO transactions (account_id, date, payee, amount, transfer_account_id) VALUES (1, ?, ?, -100, ?)"
    )
    .run(date, payee, transferAccountId);
}

/** Stub the network so every payee "misses" without leaving the process. */
function stubFetchAllMisses() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(null, { status: 404 }));
}

/**
 * Run a refresh with fake timers so the polite inter-fetch delay costs no real
 * wall-clock; the fake clock still starts at the real "now", which the
 * stale-miss rule compares against.
 */
async function runRefresh(retryMisses?: boolean) {
  vi.useFakeTimers();
  try {
    const promise = refreshPayeeIcons(makeDb(), retryMisses);
    await vi.runAllTimersAsync();
    return await promise;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(DDL);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "payee-icons-"));
  process.env.TEST_ICON_DIR = tmpDir;
});

afterEach(() => {
  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("getIconPayees", () => {
  it("returns every distinct payee, newest-seen first", () => {
    tx("Old Shop", "2020-01-01");
    tx("Old Shop", "2020-02-01");
    tx("New Cafe", "2026-08-31");
    expect(getIconPayees(makeDb())).toEqual(["New Cafe", "Old Shop"]);
  });

  it("excludes transfers and empty payees", () => {
    tx("Real Payee", "2026-01-01");
    tx("Transfer Payee", "2026-01-02", 2);
    tx("", "2026-01-03");
    expect(getIconPayees(makeDb())).toEqual(["Real Payee"]);
  });

  it("is not capped like the autocomplete list", () => {
    for (let i = 0; i < 350; i++) tx(`Payee ${i}`, "2026-01-01");
    expect(getIconPayees(makeDb())).toHaveLength(350);
  });
});

describe("refreshPayeeIcons", () => {
  it("reaches rare, recent payees that the 300-row autocomplete list omitted", async () => {
    stubFetchAllMisses();
    // 300 frequent old payees, plus one brand-new one-off.
    for (let i = 0; i < 300; i++) {
      tx(`Frequent ${i}`, "2020-01-01");
      tx(`Frequent ${i}`, "2020-01-02");
    }
    tx("Brand New Cafe", "2026-08-31");

    await runRefresh();

    const row = sqlite
      .prepare("SELECT status FROM payee_icons WHERE payee = ?")
      .get("Brand New Cafe") as { status: string } | undefined;
    expect(row?.status).toBe("none");
  });

  it("stops once the run budget is up and reports the rest as remaining", async () => {
    stubFetchAllMisses();
    // The fake clock advances by the polite delay per payee, so a backlog this
    // size runs past the 60s budget well before the list is exhausted.
    const total = 600;
    for (let i = 0; i < total; i++) tx(`Payee ${i}`, "2026-01-01");

    const result = await runRefresh();

    expect(result.remaining).toBeGreaterThan(0);
    expect(result.fetched + result.missed).toBeLessThan(total);
    expect(result.fetched + result.missed + result.remaining).toBe(total);
  });

  it("skips resolved misses but retries ones older than 30 days", async () => {
    stubFetchAllMisses();
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    tx("Fresh Miss", "2026-01-01");
    tx("Stale Miss", "2026-01-02");
    sqlite
      .prepare("INSERT INTO payee_icons (payee, domain, status, fetched_at) VALUES (?, NULL, 'none', ?)")
      .run("Fresh Miss", fresh);
    sqlite
      .prepare("INSERT INTO payee_icons (payee, domain, status, fetched_at) VALUES (?, NULL, 'none', ?)")
      .run("Stale Miss", stale);

    const result = await runRefresh();

    expect(result.skipped).toBe(1); // Fresh Miss
    expect(result.missed).toBe(1); // Stale Miss retried
  });

  it("retries every miss when retryMisses is set", async () => {
    stubFetchAllMisses();
    tx("Fresh Miss", "2026-01-01");
    sqlite
      .prepare("INSERT INTO payee_icons (payee, domain, status, fetched_at) VALUES (?, NULL, 'none', ?)")
      .run("Fresh Miss", new Date().toISOString());

    const result = await runRefresh(true);

    expect(result.skipped).toBe(0);
    expect(result.missed).toBe(1);
  });
});

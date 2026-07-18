import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import {
  computeSyncDelta,
  createHolding,
  deleteHolding,
  getAccountDetail,
  getHoldingsView,
  refreshHoldingPrices,
  syncHoldingsBalance,
  updateHolding,
} from "./queries";

/**
 * Investments: holdings CRUD, the priced holdings view, the Yahoo
 * price-refresh orchestration (network mocked — never hits the real
 * endpoint), and the sync-balance adjustment. Same in-memory SQLite fixture
 * pattern as queries.test.ts/reconciliation.test.ts — never data/budget.db.
 */

let sqlite: Database.Database;

function makeDb() {
  return drizzle(sqlite, { schema });
}

const DDL = `
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  payment_category_id INTEGER
);
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
  import_hash TEXT
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL DEFAULT 0
);
CREATE TABLE prices (
  symbol TEXT PRIMARY KEY,
  price_rappen INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  currency TEXT,
  fx_rate REAL,
  fetch_error TEXT
);
`;

const TRACKING_ACCOUNT = 1;

function seed() {
  sqlite.exec(DDL);
  sqlite.exec(`
    INSERT INTO accounts (id, name, type) VALUES (${TRACKING_ACCOUNT}, 'Brokerage', 'tracking');
    INSERT INTO settings (key, value) VALUES ('currency', 'CHF');
  `);
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  seed();
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
});

describe("holdings CRUD", () => {
  it("creates, updates and deletes a holding", () => {
    const dbi = makeDb();
    const id = createHolding(dbi, TRACKING_ACCOUNT, { symbol: "VWRL.SW", name: "Vanguard All-World", quantity: 10.5 });

    let view = getHoldingsView(TRACKING_ACCOUNT, dbi);
    expect(view.holdings).toHaveLength(1);
    expect(view.holdings[0]).toMatchObject({ symbol: "VWRL.SW", quantity: 10.5, priceRappen: null, valueRappen: null });
    expect(view.hasAllPrices).toBe(false);

    updateHolding(dbi, id, { symbol: "VWRL.SW", name: "Vanguard All-World", quantity: 12 });
    view = getHoldingsView(TRACKING_ACCOUNT, dbi);
    expect(view.holdings[0].quantity).toBe(12);

    deleteHolding(dbi, id);
    view = getHoldingsView(TRACKING_ACCOUNT, dbi);
    expect(view.holdings).toHaveLength(0);
  });
});

describe("getHoldingsView", () => {
  it("computes per-holding value and portfolio total from cached prices", () => {
    const dbi = makeDb();
    createHolding(dbi, TRACKING_ACCOUNT, { symbol: "VWRL.SW", name: "", quantity: 10 });
    createHolding(dbi, TRACKING_ACCOUNT, { symbol: "VOO", name: "", quantity: 2 });
    sqlite.exec(`
      INSERT INTO prices (symbol, price_rappen, fetched_at, currency, fx_rate) VALUES
        ('VWRL.SW', 14622, '${new Date().toISOString()}', 'CHF', NULL),
        ('VOO', 39900, '${new Date().toISOString()}', 'CHF', NULL);
    `);

    const view = getHoldingsView(TRACKING_ACCOUNT, dbi);
    expect(view.hasAllPrices).toBe(true);
    expect(view.holdings.find((h) => h.symbol === "VWRL.SW")?.valueRappen).toBe(146220);
    expect(view.holdings.find((h) => h.symbol === "VOO")?.valueRappen).toBe(79800);
    expect(view.totalValueRappen).toBe(146220 + 79800);
    expect(view.needsRefresh).toBe(false);
  });

  it("flags needsRefresh when a price is missing or stale", () => {
    const dbi = makeDb();
    createHolding(dbi, TRACKING_ACCOUNT, { symbol: "VWRL.SW", name: "", quantity: 10 });
    expect(getHoldingsView(TRACKING_ACCOUNT, dbi).needsRefresh).toBe(true);

    const staleIso = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    sqlite.exec(
      `INSERT INTO prices (symbol, price_rappen, fetched_at) VALUES ('VWRL.SW', 14622, '${staleIso}')`
    );
    expect(getHoldingsView(TRACKING_ACCOUNT, dbi).needsRefresh).toBe(true);
  });
});

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

const CHF_QUOTE = {
  chart: { result: [{ meta: { currency: "CHF", regularMarketPrice: 146.22 } }], error: null },
};
const USD_QUOTE = {
  chart: { result: [{ meta: { currency: "USD", regularMarketPrice: 165.3 } }], error: null },
};
const USDCHF_QUOTE = {
  chart: { result: [{ meta: { currency: "CHF", regularMarketPrice: 0.8069 } }], error: null },
};
const NOT_FOUND = {
  chart: { result: null, error: { description: "No data found, symbol may be delisted" } },
};

describe("refreshHoldingPrices", () => {
  it("caches a same-currency quote with no FX conversion", async () => {
    const dbi = makeDb();
    createHolding(dbi, TRACKING_ACCOUNT, { symbol: "VWRL.SW", name: "", quantity: 1 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(CHF_QUOTE)));

    const result = await refreshHoldingPrices(dbi, TRACKING_ACCOUNT);
    expect(result.updated).toEqual(["VWRL.SW"]);
    expect(result.failed).toEqual([]);

    const view = getHoldingsView(TRACKING_ACCOUNT, dbi);
    expect(view.holdings[0].priceRappen).toBe(14622);
    expect(view.holdings[0].fxRate).toBeNull();
    expect(view.holdings[0].currency).toBe("CHF");
  });

  it("converts a foreign-currency quote via a fetched FX rate", async () => {
    const dbi = makeDb();
    createHolding(dbi, TRACKING_ACCOUNT, { symbol: "VOO", name: "", quantity: 1 });
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("USDCHF")) return Promise.resolve(jsonResponse(USDCHF_QUOTE));
      return Promise.resolve(jsonResponse(USD_QUOTE));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshHoldingPrices(dbi, TRACKING_ACCOUNT);
    expect(result.updated).toEqual(["VOO"]);

    const view = getHoldingsView(TRACKING_ACCOUNT, dbi);
    // 165.30 USD * 0.8069 -> 13338 Rappen (see prices.test.ts for the rounding case).
    expect(view.holdings[0].priceRappen).toBe(13338);
    expect(view.holdings[0].currency).toBe("USD");
    expect(view.holdings[0].fxRate).toBeCloseTo(0.8069);
  });

  it("keeps the last cached price and records an error when a fetch fails", async () => {
    const dbi = makeDb();
    createHolding(dbi, TRACKING_ACCOUNT, { symbol: "VWRL.SW", name: "", quantity: 1 });
    const oldFetchedAt = new Date("2026-01-01T00:00:00Z").toISOString();
    sqlite.exec(
      `INSERT INTO prices (symbol, price_rappen, fetched_at, currency) VALUES ('VWRL.SW', 14000, '${oldFetchedAt}', 'CHF')`
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(NOT_FOUND)));

    const result = await refreshHoldingPrices(dbi, TRACKING_ACCOUNT);
    expect(result.updated).toEqual([]);
    expect(result.failed).toEqual([{ symbol: "VWRL.SW", error: "No data found, symbol may be delisted" }]);

    const view = getHoldingsView(TRACKING_ACCOUNT, dbi);
    expect(view.holdings[0].priceRappen).toBe(14000); // unchanged
    expect(view.holdings[0].fetchedAt).toBe(oldFetchedAt); // unchanged
    expect(view.holdings[0].fetchError).toBe("No data found, symbol may be delisted");
  });

  it("does not insert a price row for a brand-new symbol whose first fetch fails", async () => {
    const dbi = makeDb();
    createHolding(dbi, TRACKING_ACCOUNT, { symbol: "GHOST", name: "", quantity: 1 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(NOT_FOUND)));

    await refreshHoldingPrices(dbi, TRACKING_ACCOUNT);
    const view = getHoldingsView(TRACKING_ACCOUNT, dbi);
    expect(view.holdings[0].priceRappen).toBeNull();
  });
});

describe("computeSyncDelta", () => {
  it("returns null when balance already equals portfolio value", () => {
    expect(computeSyncDelta(100_000, 100_000)).toBeNull();
  });

  it("returns the signed delta needed to reach the portfolio value", () => {
    expect(computeSyncDelta(100_000, 120_000)).toBe(20_000);
    expect(computeSyncDelta(120_000, 100_000)).toBe(-20_000);
  });
});

describe("syncHoldingsBalance", () => {
  function seedPricedHolding(dbi: ReturnType<typeof makeDb>) {
    createHolding(dbi, TRACKING_ACCOUNT, { symbol: "VWRL.SW", name: "", quantity: 10 });
    sqlite.exec(
      `INSERT INTO prices (symbol, price_rappen, fetched_at, currency) VALUES ('VWRL.SW', 14622, '${new Date().toISOString()}', 'CHF')`
    );
  }

  it("books a Balance Adjustment transaction for the delta and zeroes it out", () => {
    const dbi = makeDb();
    seedPricedHolding(dbi);
    // Account currently has no transactions -> balance 0, portfolio value 146220.
    const result = syncHoldingsBalance(dbi, TRACKING_ACCOUNT);
    expect(result).toEqual({ ok: true, delta: 146220 });

    const detail = getAccountDetail(TRACKING_ACCOUNT, dbi);
    expect(detail?.balance).toBe(146220);

    const txn = sqlite.prepare("SELECT * FROM transactions WHERE account_id = ?").get(TRACKING_ACCOUNT) as {
      payee: string;
      memo: string;
      amount: number;
      category_id: number | null;
    };
    expect(txn.payee).toBe("Balance Adjustment");
    expect(txn.memo).toBe("Synced to holdings value");
    expect(txn.amount).toBe(146220);
    expect(txn.category_id).toBeNull();
  });

  it("books a negative adjustment when the account balance exceeds portfolio value", () => {
    const dbi = makeDb();
    seedPricedHolding(dbi);
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared) VALUES (${TRACKING_ACCOUNT}, '2026-01-01', 'Deposit', 200000, 1)`
    );
    const result = syncHoldingsBalance(dbi, TRACKING_ACCOUNT);
    expect(result).toEqual({ ok: true, delta: 146220 - 200000 });
    expect(getAccountDetail(TRACKING_ACCOUNT, dbi)?.balance).toBe(146220);
  });

  it("refuses to sync when a holding has no cached price yet", () => {
    const dbi = makeDb();
    createHolding(dbi, TRACKING_ACCOUNT, { symbol: "VWRL.SW", name: "", quantity: 10 });
    const result = syncHoldingsBalance(dbi, TRACKING_ACCOUNT);
    expect(result).toEqual({ ok: false, error: "Fetch prices before syncing." });
  });

  it("refuses to sync when already in sync", () => {
    const dbi = makeDb();
    seedPricedHolding(dbi);
    sqlite.exec(
      `INSERT INTO transactions (account_id, date, payee, amount, cleared) VALUES (${TRACKING_ACCOUNT}, '2026-01-01', 'Deposit', 146220, 1)`
    );
    const result = syncHoldingsBalance(dbi, TRACKING_ACCOUNT);
    expect(result).toEqual({ ok: false, error: "Already in sync." });
  });

  it("refuses to sync an account with no holdings", () => {
    const dbi = makeDb();
    const result = syncHoldingsBalance(dbi, TRACKING_ACCOUNT);
    expect(result).toEqual({ ok: false, error: "No holdings to sync." });
  });
});

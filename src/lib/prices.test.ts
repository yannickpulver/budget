import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchYahooQuote,
  fxSymbol,
  isStale,
  parseYahooChartResponse,
  toBudgetMinorUnits,
} from "./prices";

/**
 * Unit tests for the Yahoo Finance price-fetch module. Response parsing and
 * money math are pure and tested directly; `fetchYahooQuote` is tested with
 * a mocked `global.fetch` — no real network call is ever made in this suite.
 */

const CHART_OK = {
  chart: {
    result: [
      {
        meta: {
          currency: "CHF",
          symbol: "VWRL.SW",
          regularMarketPrice: 146.22,
          longName: "Vanguard FTSE All-World UCITS ETF",
        },
      },
    ],
    error: null,
  },
};

const CHART_NOT_FOUND = {
  chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } },
};

describe("parseYahooChartResponse", () => {
  it("extracts price and currency from a valid chart response", () => {
    const result = parseYahooChartResponse(CHART_OK);
    expect(result).toEqual({ ok: true, quote: { price: 146.22, currency: "CHF" } });
  });

  it("surfaces Yahoo's own error description for an unknown symbol", () => {
    const result = parseYahooChartResponse(CHART_NOT_FOUND);
    expect(result).toEqual({ ok: false, error: "No data found, symbol may be delisted" });
  });

  it("fails soft on malformed JSON shapes", () => {
    expect(parseYahooChartResponse(null)).toEqual({ ok: false, error: "Malformed response." });
    expect(parseYahooChartResponse({})).toEqual({ ok: false, error: "Malformed response." });
    expect(parseYahooChartResponse({ chart: {} })).toEqual({ ok: false, error: "No data returned." });
    expect(parseYahooChartResponse({ chart: { result: [] } })).toEqual({ ok: false, error: "No data returned." });
    expect(parseYahooChartResponse({ chart: { result: [{}] } })).toEqual({ ok: false, error: "Malformed response." });
  });

  it("fails when the price or currency field is missing", () => {
    expect(parseYahooChartResponse({ chart: { result: [{ meta: { currency: "USD" } }] } })).toEqual({
      ok: false,
      error: "No price in response.",
    });
    expect(
      parseYahooChartResponse({ chart: { result: [{ meta: { regularMarketPrice: 12.3 } }] } })
    ).toEqual({ ok: false, error: "No currency in response." });
  });
});

describe("fxSymbol", () => {
  it("builds Yahoo's FX chart symbol", () => {
    expect(fxSymbol("USD", "CHF")).toBe("USDCHF=X");
  });
});

describe("toBudgetMinorUnits", () => {
  it("converts a same-currency price to minor units without a rate", () => {
    expect(toBudgetMinorUnits(146.22, null)).toBe(14622);
  });

  it("applies an FX rate before rounding to minor units", () => {
    // 165.30 USD * 0.8069 CHF/USD = 133.38... -> rounds to nearest Rappen.
    expect(toBudgetMinorUnits(165.3, 0.8069)).toBe(13338);
  });

  it("rounds to the nearest minor unit", () => {
    expect(toBudgetMinorUnits(1, 1.006)).toBe(101); // 100.6 -> rounds up
    expect(toBudgetMinorUnits(1, 1.004)).toBe(100); // 100.4 -> rounds down
  });
});

describe("isStale", () => {
  const now = new Date("2026-07-18T12:00:00Z").getTime();

  it("treats a never-fetched price as stale", () => {
    expect(isStale(null, now)).toBe(true);
  });

  it("treats an unparseable timestamp as stale", () => {
    expect(isStale("not-a-date", now)).toBe(true);
  });

  it("is fresh within 24 hours", () => {
    expect(isStale(new Date(now - 23 * 60 * 60 * 1000).toISOString(), now)).toBe(false);
  });

  it("is stale past 24 hours", () => {
    expect(isStale(new Date(now - 25 * 60 * 60 * 1000).toISOString(), now)).toBe(true);
  });
});

describe("fetchYahooQuote", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed quote on a successful fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => CHART_OK,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchYahooQuote("VWRL.SW");
    expect(result).toEqual({ ok: true, quote: { price: 146.22, currency: "CHF" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("VWRL.SW");
  });

  it("fails soft on a non-OK HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    );
    const result = await fetchYahooQuote("VWRL.SW");
    expect(result).toEqual({ ok: false, error: "HTTP 500" });
  });

  it("fails soft when fetch itself throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );
    const result = await fetchYahooQuote("VWRL.SW");
    expect(result).toEqual({ ok: false, error: "network down" });
  });
});

/**
 * Yahoo Finance price fetching for tracking-account holdings.
 *
 * Yahoo's unofficial, keyless "chart" endpoint doubles as a quote API: the
 * `meta` block of a 1-day chart carries `regularMarketPrice` and `currency`.
 * Same endpoint shape works for FX pairs (e.g. "USDCHF=X"), which is how we
 * convert a holding's native-currency price into the budget's currency.
 *
 * This is the ONLY module in the app that reaches the network — the
 * self-host privacy promise depends on that staying true, so nothing here
 * should be imported by code that isn't the price-refresh path.
 *
 * Parsing is pure and unit-tested without touching the network; the actual
 * `fetch` call is a thin, timeout-bound wrapper around it.
 */

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const FETCH_TIMEOUT_MS = 5000;
const STALE_MS = 24 * 60 * 60 * 1000;

export interface YahooQuote {
  /** Native currency, major units (e.g. 146.22 CHF). */
  price: number;
  /** ISO currency code as reported by Yahoo, e.g. "CHF", "USD". */
  currency: string;
}

export type YahooQuoteResult = { ok: true; quote: YahooQuote } | { ok: false; error: string };

/** Parse the chart endpoint's JSON body into a quote. Pure — no network. */
export function parseYahooChartResponse(json: unknown): YahooQuoteResult {
  if (typeof json !== "object" || json === null) return { ok: false, error: "Malformed response." };
  const chart = (json as { chart?: unknown }).chart;
  if (typeof chart !== "object" || chart === null) return { ok: false, error: "Malformed response." };

  const errorObj = (chart as { error?: unknown }).error;
  if (errorObj && typeof errorObj === "object") {
    const desc = (errorObj as { description?: unknown }).description;
    return { ok: false, error: typeof desc === "string" ? desc : "Symbol not found." };
  }

  const result = (chart as { result?: unknown }).result;
  if (!Array.isArray(result) || result.length === 0) return { ok: false, error: "No data returned." };

  const meta = (result[0] as { meta?: unknown } | undefined)?.meta;
  if (typeof meta !== "object" || meta === null) return { ok: false, error: "Malformed response." };

  const price = (meta as { regularMarketPrice?: unknown }).regularMarketPrice;
  const currency = (meta as { currency?: unknown }).currency;
  if (typeof price !== "number" || !Number.isFinite(price)) {
    return { ok: false, error: "No price in response." };
  }
  if (typeof currency !== "string" || currency === "") {
    return { ok: false, error: "No currency in response." };
  }
  return { ok: true, quote: { price, currency } };
}

/** Fetch one symbol's quote with a hard timeout. Fails soft — never throws. */
export async function fetchYahooQuote(symbol: string): Promise<YahooQuoteResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${YAHOO_CHART_URL}${encodeURIComponent(symbol)}?range=1d&interval=1d`, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json: unknown = await res.json();
    return parseYahooChartResponse(json);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { ok: false, error: "Timed out." };
    return { ok: false, error: err instanceof Error ? err.message : "Fetch failed." };
  } finally {
    clearTimeout(timeout);
  }
}

/** Yahoo's FX chart symbol converting `from` -> `to`, e.g. ("USD","CHF") -> "USDCHF=X". */
export function fxSymbol(from: string, to: string): string {
  return `${from}${to}=X`;
}

/**
 * Convert a native-currency price (major units) into the budget currency's
 * minor units (Rappen/cents), rounding once at the end. `fxRate` converts
 * native -> budget; pass null when the currencies already match.
 */
export function toBudgetMinorUnits(nativePrice: number, fxRate: number | null): number {
  return Math.round(nativePrice * (fxRate ?? 1) * 100);
}

/** A cached price is stale once it's older than 24h, or was never fetched. */
export function isStale(fetchedAt: string | null, now: number = Date.now()): boolean {
  if (!fetchedAt) return true;
  const t = new Date(fetchedAt).getTime();
  if (Number.isNaN(t)) return true;
  return now - t > STALE_MS;
}

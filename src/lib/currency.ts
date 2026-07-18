/**
 * Currency helpers. Amounts are integer minor units (Rappen/cents).
 * Display uses Swiss grouping: 1'234.50.
 */

/** Format minor units as Swiss-style "1'234.50" (no currency code). */
export function formatMoney(minorUnits: number): string {
  const negative = minorUnits < 0;
  const abs = Math.abs(minorUnits);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  const body = `${grouped}.${String(cents).padStart(2, "0")}`;
  return negative ? `-${body}` : body;
}

/** Format with the currency code, e.g. "CHF 1'234.50". */
export function formatCurrency(minorUnits: number, currency: string): string {
  return `${currency} ${formatMoney(minorUnits)}`;
}

/**
 * Parse user input into minor units. Accepts "120", "120.50", "1'200",
 * "1'200.50", optional leading minus and surrounding whitespace. Apostrophes
 * (and spaces) are treated as thousands separators. Returns null if unparseable.
 */
export function parseMoneyInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const cleaned = trimmed.replace(/['\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/**
 * Parse a holding quantity: a positive decimal, arbitrary precision (for
 * fractional shares). Accepts a comma as the decimal separator. Returns null
 * if unparseable or not strictly positive.
 */
export function parseQuantityInput(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value > 0 ? value : null;
}

/** Format a quantity for display, trimming trailing zeros beyond 2 decimals. */
export function formatQuantity(quantity: number): string {
  return quantity.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 6 });
}

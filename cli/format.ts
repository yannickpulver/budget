/** Amount parsing and output helpers for the CLI. Amounts are integer minor units (Rappen/cents). */

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

/** Pad rows into aligned columns joined by two spaces. Columns default to left-aligned. */
export function table(rows: string[][], align: ("l" | "r")[] = []): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (align[i] === "r" ? cell.padStart(widths[i]) : cell.padEnd(widths[i])))
      .join("  ")
      .trimEnd(),
  );
}

/**
 * Parse user input into minor units. Accepts "120", "120.50", "1'200",
 * "1'200.50", optional leading minus and surrounding whitespace. Returns null
 * if unparseable. Kept in sync with the app's own parser by hand — the CLI
 * ships without dependencies on src/.
 */
export function parseMoneyInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const cleaned = trimmed.replace(/['\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/**
 * Checks `date` is `YYYY-MM-DD` and a real calendar date (rejects e.g.
 * "2025-13-45"). Kept in sync with src/lib/validation.ts by hand — the CLI
 * ships without dependencies on src/.
 */
export function isValidIsoDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/** `field old → new` for every key whose rendered value differs, in `after`'s key order. */
export function changedFields(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(after)
    .filter((key) => before[key] !== after[key])
    .map((key) => `${key} ${before[key]} → ${after[key]}`);
}

/**
 * Signed amount for an edit. `magnitude` is the new absolute amount (null when
 * `--amount` was not given). `inflow`/`outflow` force the sign; with neither,
 * the row keeps the direction it already had.
 */
export function resolveEditAmount(
  currentAmount: number,
  magnitude: number | null,
  inflow: boolean,
  outflow: boolean
): number | undefined {
  if (magnitude === null && !inflow && !outflow) return undefined;
  const abs = Math.abs(magnitude ?? currentAmount);
  if (inflow) return abs;
  if (outflow) return -abs;
  return currentAmount < 0 ? -abs : abs;
}

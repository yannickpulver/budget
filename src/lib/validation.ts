/**
 * Shared guard for numeric inputs a server action is about to write to the
 * DB (money amounts in minor units, monthly targets, holding quantities).
 * Rejects non-finite values (`NaN`/`Infinity` — malformed client input or an
 * arithmetic slip) and absurdly large magnitudes that are almost certainly a
 * bug or a unit mismatch (e.g. major vs. minor units) rather than a real
 * transaction, so a bad request can't silently corrupt budget math.
 */
export const MAX_ABS_NUMBER = 1e13;

export function isValidNumber(value: number, max: number = MAX_ABS_NUMBER): boolean {
  return Number.isFinite(value) && Math.abs(value) <= max;
}

/** Checks `date` is `YYYY-MM-DD` and a real calendar date (rejects e.g. `2025-13-45`). */
export function isValidIsoDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

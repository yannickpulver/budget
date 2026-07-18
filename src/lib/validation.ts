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

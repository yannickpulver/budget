/**
 * Presentation helpers shared by the /stats pages. Pure formatting/geometry —
 * no React, no DB — so a client component (`spending-groups.tsx`) can import
 * it without dragging the server-rendered `ui.tsx` module into its bundle.
 */
import { formatMoneyWhole } from "./currency";

/**
 * Changes below this magnitude (Rappen — CHF 0.50) read as "no change".
 * Deltas are displayed rounded to whole francs, so anything smaller would
 * render as "+CHF 0", which says less than saying nothing.
 */
export const DELTA_NOISE_FLOOR = 50;

/** True when a change is too small to be worth stating. */
export function isNoChange(change: number): boolean {
  return Math.abs(change) < DELTA_NOISE_FLOOR;
}

/**
 * "+CHF 180 (+17%)" / "−CHF 40 · −3%" — a signed whole-franc amount with an
 * optional percentage. `separator` picks the shape: "parens" for a standalone
 * sentence-like delta, "middot" for a tile line where a label follows.
 *
 * The percent carries the same sign as the amount: `delta()` already divides
 * by |previous| and suppresses the percent entirely when the two figures
 * straddle zero, so the sign here is the change's own.
 */
export function formatDelta(
  change: number,
  percent: number | null,
  currency: string,
  options: { separator?: "parens" | "middot" } = {}
): string {
  const sign = change >= 0 ? "+" : "−";
  const amount = `${sign}${currency} ${formatMoneyWhole(change)}`;
  if (percent == null) return amount;
  const pct = `${sign}${Math.round(Math.abs(percent) * 100)}%`;
  return options.separator === "middot" ? `${amount} · ${pct}` : `${amount} (${pct})`;
}

/**
 * Bar fill width in percent for a value against a scale ceiling. A positive
 * value never renders thinner than 2% — a small-but-real amount should still
 * be visible — while zero (or an inflow-only negative) renders as no bar at
 * all, because there is nothing there to see.
 */
export function barWidth(value: number, ceiling: number): number {
  if (value <= 0) return 0;
  if (ceiling <= 0) return 2;
  return Math.max(2, Math.min(100, (value / ceiling) * 100));
}

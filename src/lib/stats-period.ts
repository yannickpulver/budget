/**
 * Stats period parsing/formatting helpers. Pure — no DB imports — because
 * this module is shared between the server query layer (src/lib/queries.ts,
 * src/lib/stats-queries.ts) and client/server React components under
 * src/app/stats.
 */

/** "all" | "YYYY" | "YYYY-MM" */
export type StatsPeriod = string;
export type PeriodMode = "month" | "year" | "all";

const MONTH_PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_PERIOD_RE = /^\d{4}$/;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const MONTH_SHORT_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function periodMode(period: StatsPeriod): PeriodMode {
  if (period === "all") return "all";
  if (MONTH_PERIOD_RE.test(period)) return "month";
  if (YEAR_PERIOD_RE.test(period)) return "year";
  return "month";
}

/** YYYY-MM key for a Date. */
export function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** The current period for a given mode: "2026-08" | "2026" | "all". */
export function currentPeriod(mode: PeriodMode, now: Date = new Date()): StatsPeriod {
  if (mode === "all") return "all";
  if (mode === "year") return String(now.getFullYear());
  return monthKeyOf(now);
}

/**
 * Accepts a raw search param. Maps legacy values ("month" -> current YYYY-MM,
 * "year" -> current YYYY, "all" -> "all") and anything invalid/undefined to
 * the default (current month). A month/year period later than now is clamped
 * to the current month/year — otherwise a hand-edited `?period=2030-05` URL
 * reaches the query layer and renders a page of zeros whose nav label
 * disagrees with the data. Consistent with `shiftPeriod`, which already
 * refuses to navigate into the future. "all" is never clamped.
 */
export function parseStatsPeriod(raw: string | undefined, now: Date = new Date()): StatsPeriod {
  if (raw == null) return currentPeriod("month", now);
  if (raw === "month") return currentPeriod("month", now);
  if (raw === "year") return currentPeriod("year", now);
  if (raw === "all") return "all";
  if (MONTH_PERIOD_RE.test(raw)) return raw > monthKeyOf(now) ? currentPeriod("month", now) : raw;
  if (YEAR_PERIOD_RE.test(raw)) return Number(raw) > now.getFullYear() ? currentPeriod("year", now) : raw;
  return currentPeriod("month", now);
}

/** Half-open bounds [start, end). null/null for "all". */
export function statsPeriodBounds(period: StatsPeriod): { start: string | null; end: string | null } {
  const mode = periodMode(period);
  if (mode === "all") return { start: null, end: null };
  if (mode === "year") {
    const y = Number(period);
    return { start: `${y}-01-01`, end: `${y + 1}-01-01` };
  }
  const [y, m] = period.split("-").map(Number);
  const nextYear = m === 12 ? y + 1 : y;
  const nextMonth = m === 12 ? 1 : m + 1;
  return {
    start: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`,
    end: `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`,
  };
}

/** "August 2026" | "2026" | "All time" */
export function statsPeriodLabel(period: StatsPeriod): string {
  const mode = periodMode(period);
  if (mode === "all") return "All time";
  if (mode === "year") return period;
  const [y, m] = period.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** "YYYY-MM" -> "YYYY-MM" shifted by `delta` months (no clamping). */
export function monthKeyShift(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`;
}

/**
 * Shift a month/year period by delta; returns null for "all" or when it
 * would go past `now` (no navigating into the future).
 */
export function shiftPeriod(period: StatsPeriod, delta: number, now: Date = new Date()): StatsPeriod | null {
  const mode = periodMode(period);
  if (mode === "all") return null;
  if (mode === "year") {
    const y = Number(period) + delta;
    if (y > now.getFullYear()) return null;
    return String(y);
  }
  const candidate = monthKeyShift(period, delta);
  if (candidate > monthKeyOf(now)) return null;
  return candidate;
}

/** "2026-07" -> "Jul 2026". */
export function monthShortLabel(monthKey: string): string {
  const [year, mon] = monthKey.split("-").map(Number);
  return `${MONTH_SHORT_NAMES[mon - 1]} ${year}`;
}

/**
 * "2026-07" -> "Jul", with January carrying the year ("Jan '26") — for dense
 * chart axes.
 */
export function monthAxisLabel(monthKey: string): string {
  const [year, mon] = monthKey.split("-").map(Number);
  if (mon === 1) return `Jan '${String(year).slice(-2)}`;
  return MONTH_SHORT_NAMES[mon - 1];
}

/** Inclusive list of YYYY-MM keys from a to b. */
export function monthKeysBetween(a: string, b: string): string[] {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  const start = ay * 12 + (am - 1);
  const end = by * 12 + (bm - 1);
  const keys: string[] = [];
  for (let t = start; t <= end; t++) {
    const y = Math.floor(t / 12);
    const m = (t % 12) + 1;
    keys.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`);
  }
  return keys;
}

/** Number of calendar months in [from, to] inclusive (YYYY-MM keys). */
export function monthSpan(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

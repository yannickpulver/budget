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

// ---------------------------------------------------------------------------
// Period comparison ("vs last month / vs last year")
// ---------------------------------------------------------------------------

/** Days in a 1-based (year, month). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** YYYY-MM-DD for a UTC-safe (year, month 1-based, day) triple, rolling over month/year ends. */
function isoDate(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.toISOString().slice(0, 10);
}

/**
 * The period to compare against: month -> previous month, year -> previous
 * year, "all" -> null (all time has nothing before it).
 */
export function comparisonPeriod(period: StatsPeriod): StatsPeriod | null {
  const mode = periodMode(period);
  if (mode === "all") return null;
  if (mode === "year") return String(Number(period) - 1);
  return monthKeyShift(period, -1);
}

/**
 * True when `period` is the running month or year — its numbers are still
 * moving, so a comparison against a *complete* earlier period would be unfair.
 * "all" is never treated as current (it has no comparison at all).
 */
export function isCurrentPeriod(period: StatsPeriod, now: Date = new Date()): boolean {
  const mode = periodMode(period);
  if (mode === "all") return false;
  if (mode === "year") return Number(period) === now.getFullYear();
  return period === monthKeyOf(now);
}

/**
 * Half-open date bounds [start, end) for the comparison period, aligned for
 * month-to-date fairness.
 *
 * When `period` is the current month (per `now`), the previous month is cut at
 * the same day-of-month — clamped to that month's length, so "March so far" on
 * the 31st compares against the whole of February rather than nothing — and
 * the cut day is INCLUDED, matching the running period, which includes today.
 * The same logic applies a level up for the current year: the previous year is
 * cut at the same month+day.
 *
 * A period that is already over compares against the complete previous period
 * (`partial: false`). "all" has no comparison and returns null.
 */
export function comparisonBounds(
  period: StatsPeriod,
  now: Date = new Date()
): { start: string; end: string; partial: boolean } | null {
  const mode = periodMode(period);
  if (mode === "all") return null;
  const running = isCurrentPeriod(period, now);

  if (mode === "year") {
    const prevYear = Number(period) - 1;
    const start = `${prevYear}-01-01`;
    if (!running) return { start, end: `${prevYear + 1}-01-01`, partial: false };
    const month = now.getMonth() + 1;
    const day = Math.min(now.getDate(), daysInMonth(prevYear, month));
    return { start, end: isoDate(prevYear, month, day + 1), partial: true };
  }

  const prev = monthKeyShift(period, -1);
  const [py, pm] = prev.split("-").map(Number);
  const start = `${prev}-01`;
  if (!running) return { start, end: statsPeriodBounds(period).start as string, partial: false };
  const day = Math.min(now.getDate(), daysInMonth(py, pm));
  return { start, end: isoDate(py, pm, day + 1), partial: true };
}

/**
 * Half-open date bounds [start, end) for the period ITSELF, cut the same way
 * `comparisonBounds` cuts the comparison window.
 *
 * `statsPeriodBounds` gives the full calendar month/year, which is right for a
 * period that is over. While a period is still running, though, its full
 * bounds reach past today — and pairing a full-month current total with a
 * day-cut comparison total is a one-sided comparison that flatters or
 * punishes the running period for nothing (and lets a future-dated
 * transaction leak into "so far"). So a running period ends at today+1
 * (exclusive), matching `comparisonBounds`' cut day, which is inclusive.
 *
 * `partial` is true exactly when that cut was applied. "all" has no bounds
 * and returns null.
 */
export function currentBounds(
  period: StatsPeriod,
  now: Date = new Date()
): { start: string; end: string; partial: boolean } | null {
  const mode = periodMode(period);
  if (mode === "all") return null;
  const { start, end } = statsPeriodBounds(period);
  if (!isCurrentPeriod(period, now)) {
    return { start: start as string, end: end as string, partial: false };
  }
  return {
    start: start as string,
    end: isoDate(now.getFullYear(), now.getMonth() + 1, now.getDate() + 1),
    partial: true,
  };
}

/**
 * Short label for the comparison shown next to a delta: "vs Jul", "vs 2025",
 * or "vs Jul so far" when the comparison window is cut short to match a
 * running period. Null for "all".
 */
export function comparisonLabel(period: StatsPeriod, now: Date = new Date()): string | null {
  const previous = comparisonPeriod(period);
  if (previous == null) return null;
  const bounds = comparisonBounds(period, now);
  const suffix = bounds?.partial ? " so far" : "";
  if (periodMode(period) === "year") return `vs ${previous}${suffix}`;
  const month = Number(previous.split("-")[1]);
  return `vs ${MONTH_SHORT_NAMES[month - 1]}${suffix}`;
}

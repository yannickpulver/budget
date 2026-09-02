/**
 * Query functions backing the redesigned `/stats` page: net worth history,
 * monthly cashflow, spending-by-group, top payees and trips. Complements the
 * simpler category-drilldown stats in queries.ts (`getCategoryStats`).
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq, gte, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { BALANCE_ADJUSTMENT_PAYEE, getCurrency, STARTING_BALANCE_PAYEE } from "./queries";
import {
  comparisonBounds,
  currentBounds,
  isCurrentPeriod,
  monthAxisLabel,
  monthKeyOf,
  monthKeyShift,
  monthKeysBetween,
  periodMode,
  statsPeriodBounds,
  type StatsPeriod,
} from "./stats-period";
import { db } from "@/db";
import * as schema from "@/db/schema";

type DB = BetterSQLite3Database<typeof schema>;

/** Removes a leading "1. " / "12. " style ordering prefix from a group name. */
export function stripGroupPrefix(name: string): string {
  return name.replace(/^\d+\.\s*/, "");
}

/**
 * Minimum previous-period magnitude (Rappen — CHF 20) for a percentage change
 * to be meaningful. Below it, "+400%" is noise about a rounding-error base, so
 * `percent` is suppressed and only the absolute `change` is worth showing.
 */
export const DELTA_PERCENT_FLOOR = 2000;

export interface Delta {
  current: number;
  previous: number;
  /** current - previous, in Rappen (negative = went down). */
  change: number;
  /**
   * change / |previous| — the magnitude of the base, so the percent's sign is
   * the change's own sign and never flips on a negative previous figure.
   * Null when `previous` is under `DELTA_PERCENT_FLOOR`, or when the two
   * figures straddle zero (see `delta`).
   */
  percent: number | null;
}

/**
 * Absolute and relative change between two Rappen amounts.
 *
 * `percent` is suppressed in two cases, because a number would mislead rather
 * than inform:
 *
 * - The base is tiny (`DELTA_PERCENT_FLOOR`), where any ratio is noise.
 * - `current` and `previous` have opposite signs. A Net that went from
 *   −CHF 1'200 to +CHF 1'700 is not "−243% worse"; percentages of a
 *   zero-crossing quantity have no reading. The absolute change says it all.
 */
export function delta(current: number, previous: number): Delta {
  const change = current - previous;
  const crossesZero = current !== 0 && previous !== 0 && Math.sign(current) !== Math.sign(previous);
  const percent =
    Math.abs(previous) < DELTA_PERCENT_FLOOR || crossesZero ? null : change / Math.abs(previous);
  return { current, previous, change, percent };
}

/** Total of an iterable of numbers. */
function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/** Inclusive day count between two YYYY-MM-DD dates. */
function dayCountInclusive(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const dbEnd = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((dbEnd - da) / msPerDay) + 1;
}

/** Category ids used as any account's credit-card payment category. */
export function getPaymentCategoryIds(dbi: DB): number[] {
  return dbi
    .select({ id: schema.accounts.paymentCategoryId })
    .from(schema.accounts)
    .where(sql`${schema.accounts.paymentCategoryId} is not null`)
    .all()
    .map((r) => r.id as number);
}

// ---------------------------------------------------------------------------
// Net worth
// ---------------------------------------------------------------------------

export interface NetWorthPoint {
  month: string;
  /** Cumulative balance across all accounts, Rappen. */
  balance: number;
}

export interface NetWorthHistory {
  points: NetWorthPoint[];
  currency: string;
  /** True when at least one tracking account had its balance substituted with a live valuation on the last point. */
  liveValuation: boolean;
}

/**
 * Cumulative balance per month across ALL accounts (tracking included, closed
 * included), from the first transaction month through the current month, with
 * no gaps (empty months carry the running total forward).
 *
 * On the LAST point only, each tracking account is handled per one of three
 * cases:
 *
 * - No `holdings` rows at all (tracked by balance, not by instrument — e.g. a
 *   pillar-3a pension account): its transaction-derived balance is left
 *   untouched. There is nothing to value it against.
 * - Holdings rows, every symbol priced: its transaction-derived cost basis is
 *   swapped for the live valuation (`sum(quantity * prices.priceRappen)`).
 * - Holdings rows, at least one symbol missing a price: also left untouched.
 *   The account can't be fully valued, and substituting a partial sum would
 *   understate it (silently dropping the unpriced holding's value) worse than
 *   just keeping the cost basis.
 *
 * `liveValuation` is true only when at least one tracking account actually
 * had its balance substituted (case 2 happened for at least one account).
 */
export function getNetWorthHistory(dbi: DB = db, now: Date = new Date()): NetWorthHistory {
  const currency = getCurrency(dbi);

  const firstRow = dbi
    .select({ min: sql<string | null>`min(${schema.transactions.date})` })
    .from(schema.transactions)
    .get();
  const firstDate = firstRow?.min ?? null;
  if (firstDate == null) {
    return { points: [], currency, liveValuation: false };
  }

  const firstMonth = firstDate.slice(0, 7);
  const nowKey = monthKeyOf(now);
  const months = monthKeysBetween(firstMonth, nowKey);

  const monthlyRows = dbi
    .select({
      key: sql<string>`substr(${schema.transactions.date}, 1, 7)`,
      net: sql<number>`coalesce(sum(${schema.transactions.amount}), 0)`,
    })
    .from(schema.transactions)
    .groupBy(sql`substr(${schema.transactions.date}, 1, 7)`)
    .all();
  const netByMonth = new Map(monthlyRows.map((r) => [r.key, r.net]));

  const points: NetWorthPoint[] = [];
  let running = 0;
  for (const key of months) {
    running += netByMonth.get(key) ?? 0;
    points.push({ month: key, balance: running });
  }

  // Per-account transaction-derived cost basis, so each tracking account can
  // be judged (and swapped) independently rather than as one pooled total —
  // a zero-holdings account's cost basis must never be netted against
  // another account's valuation.
  const trackingCostBasisRows = dbi
    .select({
      accountId: schema.transactions.accountId,
      total: sql<number>`coalesce(sum(${schema.transactions.amount}), 0)`,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .where(eq(schema.accounts.type, "tracking"))
    .groupBy(schema.transactions.accountId)
    .all();
  const costBasisByAccount = new Map(trackingCostBasisRows.map((r) => [r.accountId, r.total]));

  const trackingHoldingRows = dbi
    .select({
      accountId: schema.holdings.accountId,
      quantity: schema.holdings.quantity,
      priceRappen: schema.prices.priceRappen,
    })
    .from(schema.holdings)
    .innerJoin(schema.accounts, eq(schema.holdings.accountId, schema.accounts.id))
    .leftJoin(schema.prices, eq(schema.holdings.symbol, schema.prices.symbol))
    .where(eq(schema.accounts.type, "tracking"))
    .all();

  const holdingsByAccount = new Map<number, { quantity: number; priceRappen: number | null }[]>();
  for (const h of trackingHoldingRows) {
    const list = holdingsByAccount.get(h.accountId) ?? [];
    list.push({ quantity: h.quantity, priceRappen: h.priceRappen });
    holdingsByAccount.set(h.accountId, list);
  }

  // Accounts with no `holdings` rows at all never appear in `holdingsByAccount`
  // and so are simply never adjusted below — their transaction-derived
  // balance passes through untouched, which is exactly the zero-holdings case.
  let liveValuation = false;
  let netAdjustment = 0;
  for (const [accountId, holdings] of holdingsByAccount) {
    const allPriced = holdings.every((h) => h.priceRappen != null);
    if (!allPriced) continue; // partially priced: keep the cost basis, don't count it.
    const valuation = holdings.reduce((sum, h) => sum + Math.round(h.quantity * (h.priceRappen as number)), 0);
    const costBasis = costBasisByAccount.get(accountId) ?? 0;
    netAdjustment += valuation - costBasis;
    liveValuation = true;
  }

  if (points.length > 0) {
    const last = points[points.length - 1];
    last.balance = last.balance + netAdjustment;
  }

  return { points, currency, liveValuation };
}

/**
 * Balance at the end of `monthKey` from an already-computed history: the last
 * point at or before that month (points carry the running total through empty
 * months, so this is exact and not an approximation). Null when the history
 * starts after `monthKey` — there was no money to speak of yet.
 *
 * Kept separate from `getNetWorthHistory` so the "vs previous period" number
 * costs no extra query: the caller already has the full series.
 */
export function netWorthAt(points: NetWorthPoint[], monthKey: string): number | null {
  let balance: number | null = null;
  for (const point of points) {
    if (point.month > monthKey) break;
    balance = point.balance;
  }
  return balance;
}

// ---------------------------------------------------------------------------
// Cashflow
// ---------------------------------------------------------------------------

export interface CashflowBucket {
  /** "YYYY-MM" for a month bucket, "YYYY" for a year bucket. */
  key: string;
  /** Display label for the bucket ("Jan '26" for months, "2026" for years) — chosen by the query, not the page. */
  label: string;
  income: number;
  spending: number;
  net: number;
  savingsRate: number | null;
  /** True when this bucket falls inside the period bounds (vs. context padding). Always true for year buckets. */
  inPeriod: boolean;
}

export interface CashflowSummary {
  /**
   * "year" only for period === "all" — 74+ monthly bars are unreadable at
   * chart width, so all-time cashflow aggregates by calendar year instead.
   * "month" for every other period.
   */
  bucket: "month" | "year";
  /** The display window, ascending. */
  entries: CashflowBucket[];
  income: number;
  spending: number;
  net: number;
  savingsRate: number | null;
  /** Always a per-MONTH average, regardless of `bucket`. */
  avgSpendingPerMonth: number;
  /**
   * Number of calendar months the period covers (1 for a month, up to 12 for a
   * year, the whole history for "all") — the divisor behind
   * `avgSpendingPerMonth`, exposed so a page can average its other totals the
   * same way instead of guessing a month count from another series.
   */
  months: number;
  /**
   * The same totals over the comparison period (previous month / previous
   * year, month-to-date aligned when the current period is still running —
   * see `comparisonBounds`). Null for "all", which has nothing before it.
   */
  previous: { income: number; spending: number; net: number } | null;
  /** True when the period is still running, so its numbers are not final. */
  partial: boolean;
  /**
   * The 12 months ending at the period's last month (Dec for a past year, the
   * current month for a running year or for "all"), for sparklines. All four
   * arrays are the same length and index-aligned.
   */
  trailing: { months: string[]; income: number[]; spending: number[]; net: number[] };
  currency: string;
}

/**
 * Per-month spending (positive Rappen) over the half-open date range
 * [startDate, endDate). "Spending" is defined by `getMonthlyCashflow`'s
 * doc comment below; this is the single implementation of it, shared by the
 * display window, the comparison period and the trailing sparkline series.
 */
function spendingByMonthBetween(
  dbi: DB,
  startDate: string,
  endDate: string,
  paymentCategoryIds: number[]
): Map<string, number> {
  const conditions = [
    isNull(schema.transactions.transferAccountId),
    sql`${schema.transactions.categoryId} is not null`,
    ne(schema.accounts.type, "tracking"),
    gte(schema.transactions.date, startDate),
    sql`${schema.transactions.date} < ${endDate}`,
  ];
  if (paymentCategoryIds.length > 0) {
    conditions.push(notInArray(schema.transactions.categoryId, paymentCategoryIds));
  }

  const rows = dbi
    .select({
      key: sql<string>`substr(${schema.transactions.date}, 1, 7)`,
      spending: sql<number>`coalesce(sum(case when ${schema.transactions.amount} < 0 then -${schema.transactions.amount} else 0 end), 0)`,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .where(and(...conditions))
    .groupBy(sql`substr(${schema.transactions.date}, 1, 7)`)
    .all();

  return new Map(rows.map((r) => [r.key, r.spending]));
}

/**
 * Per-month income over [startDate, endDate). Real income carries categoryId =
 * NULL: assigning money to a category happens from Ready to Assign, not on the
 * deposit itself. Excludes the two synthetic bookkeeping payees, which are
 * account seeding / reconciliation artifacts rather than income.
 */
function incomeByMonthBetween(dbi: DB, startDate: string, endDate: string): Map<string, number> {
  const rows = dbi
    .select({
      key: sql<string>`substr(${schema.transactions.date}, 1, 7)`,
      income: sql<number>`coalesce(sum(${schema.transactions.amount}), 0)`,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .where(
      and(
        sql`${schema.transactions.amount} > 0`,
        ne(schema.accounts.type, "tracking"),
        isNull(schema.transactions.transferAccountId),
        isNull(schema.transactions.categoryId),
        // Payee-string-deep exclusion: this only catches the two exact
        // synthetic payees written by this app today. A legacy or
        // hand-typed variant (e.g. "Manual Balance Adjustment" from an old
        // import) would slip through this filter — it's only kept out of
        // income in practice because such rows sit on tracking accounts,
        // which are excluded above regardless of payee.
        notInArray(schema.transactions.payee, [STARTING_BALANCE_PAYEE, BALANCE_ADJUSTMENT_PAYEE]),
        gte(schema.transactions.date, startDate),
        sql`${schema.transactions.date} < ${endDate}`
      )
    )
    .groupBy(sql`substr(${schema.transactions.date}, 1, 7)`)
    .all();

  return new Map(rows.map((r) => [r.key, r.income]));
}

/** Number of months in a trailing sparkline series. */
export const TRAILING_MONTHS = 12;

/**
 * income/spending per month, bucketed for display by month (or, for the
 * "all" period, by calendar year — see `bucket` on `CashflowSummary`).
 *
 * This is a YNAB-style envelope budget: assigning money to a category happens
 * from "Ready to Assign", not from the transaction itself. Real income (a
 * salary deposit, a client payment) therefore lands as an uncategorized
 * transaction — `categoryId IS NULL` — because it flows straight to Ready to
 * Assign; it is NOT "any positive categorized row" (that would just be
 * refunds landing back in a category you'd already spent from). So:
 *
 * - income = positive amount, `transferAccountId IS NULL`, `categoryId IS
 *   NULL`, non-tracking account, excluding the two synthetic bookkeeping
 *   payees (`STARTING_BALANCE_PAYEE`, `BALANCE_ADJUSTMENT_PAYEE`) — those are
 *   account seeding / reconciliation artifacts, not income.
 * - spending = negated negative amount on *categorized* rows (transfers and
 *   uncategorized rows excluded), non-tracking account, excluding any
 *   category that is a credit-card payment category (any non-null
 *   accounts.paymentCategoryId value).
 */
export function getMonthlyCashflow(period: StatsPeriod, dbi: DB = db, now: Date = new Date()): CashflowSummary {
  const currency = getCurrency(dbi);
  const mode = periodMode(period);
  const nowKey = monthKeyOf(now);

  let windowStart: string;
  let windowEnd: string;
  if (mode === "month") {
    windowEnd = period;
    windowStart = monthKeyShift(period, -11);
  } else if (mode === "year") {
    const y = Number(period);
    windowStart = `${period}-01`;
    windowEnd = y === now.getFullYear() ? nowKey : `${period}-12`;
  } else {
    const firstRow = dbi
      .select({ min: sql<string | null>`min(${schema.transactions.date})` })
      .from(schema.transactions)
      .get();
    windowStart = firstRow?.min ? firstRow.min.slice(0, 7) : nowKey;
    windowEnd = nowKey;
  }

  const windowStartDate = `${windowStart}-01`;
  const windowEndDate = `${monthKeyShift(windowEnd, 1)}-01`;

  const paymentCategoryIds = getPaymentCategoryIds(dbi);
  const spendingByMonth = spendingByMonthBetween(dbi, windowStartDate, windowEndDate, paymentCategoryIds);
  const incomeByMonth = incomeByMonthBetween(dbi, windowStartDate, windowEndDate);

  const monthRows: CashflowBucket[] = monthKeysBetween(windowStart, windowEnd).map((key) => {
    const income = incomeByMonth.get(key) ?? 0;
    const spending = spendingByMonth.get(key) ?? 0;
    const net = income - spending;
    const savingsRate = income > 0 ? net / income : null;
    const inPeriod = mode === "all" ? true : mode === "month" ? key === period : key.slice(0, 4) === period;
    return { key, label: monthAxisLabel(key), income, spending, net, savingsRate, inPeriod };
  });

  // Period totals and the per-month average are always derived from the
  // month grain, independent of how `entries` below gets bucketed for
  // display — an "all" period must not average by year bucket count.
  const periodMonthRows = monthRows.filter((m) => m.inPeriod);

  // While the period is running, its totals are cut at today the same way
  // `comparisonBounds` cuts the previous period — otherwise "so far" would be
  // measured against a full month on one side only, and a future-dated
  // transaction would count toward a month-to-date figure.
  const current = currentBounds(period, now);
  const cutTotals =
    current != null && current.partial
      ? {
          spending: sum(spendingByMonthBetween(dbi, current.start, current.end, paymentCategoryIds).values()),
          income: sum(incomeByMonthBetween(dbi, current.start, current.end).values()),
        }
      : null;

  const income = cutTotals?.income ?? periodMonthRows.reduce((s, m) => s + m.income, 0);
  const spending = cutTotals?.spending ?? periodMonthRows.reduce((s, m) => s + m.spending, 0);
  const net = income - spending;
  const savingsRate = income > 0 ? net / income : null;
  const avgSpendingPerMonth = periodMonthRows.length > 0 ? Math.round(spending / periodMonthRows.length) : 0;

  // Comparison period. Its bounds are day-precise (a running month is matched
  // day-for-day against the previous one), so the totals are summed straight
  // from a range query rather than from whole-month buckets.
  const compare = comparisonBounds(period, now);
  let previous: CashflowSummary["previous"] = null;
  if (compare != null) {
    const prevSpending = sum(spendingByMonthBetween(dbi, compare.start, compare.end, paymentCategoryIds).values());
    const prevIncome = sum(incomeByMonthBetween(dbi, compare.start, compare.end).values());
    previous = { income: prevIncome, spending: prevSpending, net: prevIncome - prevSpending };
  }

  // Trailing 12 months for the sparklines: always the month grain, always 12
  // slots (zero-filled), ending at the period's last month.
  const trailingEnd = mode === "month" ? period : mode === "year" ? (Number(period) === now.getFullYear() ? nowKey : `${period}-12`) : nowKey;
  const trailingMonths = monthKeysBetween(monthKeyShift(trailingEnd, -(TRAILING_MONTHS - 1)), trailingEnd);
  const trailingStartDate = `${trailingMonths[0]}-01`;
  const trailingEndDate = `${monthKeyShift(trailingEnd, 1)}-01`;
  const trailingSpending = spendingByMonthBetween(dbi, trailingStartDate, trailingEndDate, paymentCategoryIds);
  const trailingIncome = incomeByMonthBetween(dbi, trailingStartDate, trailingEndDate);
  const trailing = {
    months: trailingMonths,
    income: trailingMonths.map((m) => trailingIncome.get(m) ?? 0),
    spending: trailingMonths.map((m) => trailingSpending.get(m) ?? 0),
    net: trailingMonths.map((m) => (trailingIncome.get(m) ?? 0) - (trailingSpending.get(m) ?? 0)),
  };

  const partial = isCurrentPeriod(period, now);

  if (mode !== "all") {
    return {
      bucket: "month",
      entries: monthRows,
      income,
      spending,
      net,
      savingsRate,
      avgSpendingPerMonth,
      months: periodMonthRows.length,
      previous,
      partial,
      trailing,
      currency,
    };
  }

  // All-time: aggregate the monthly rows into one bucket per calendar year
  // (7 slots for years of real data, vs. 74+ monthly bars that render as
  // sub-2px noise).
  const yearTotals = new Map<string, { income: number; spending: number }>();
  for (const m of monthRows) {
    const year = m.key.slice(0, 4);
    const acc = yearTotals.get(year) ?? { income: 0, spending: 0 };
    acc.income += m.income;
    acc.spending += m.spending;
    yearTotals.set(year, acc);
  }
  const entries: CashflowBucket[] = [...yearTotals.entries()].map(([year, { income, spending }]) => {
    const net = income - spending;
    const savingsRate = income > 0 ? net / income : null;
    return { key: year, label: year, income, spending, net, savingsRate, inPeriod: true };
  });

  return {
    bucket: "year",
    entries,
    income,
    spending,
    net,
    savingsRate,
    avgSpendingPerMonth,
    months: periodMonthRows.length,
    previous,
    partial,
    trailing,
    currency,
  };
}

// ---------------------------------------------------------------------------
// Spending by group
// ---------------------------------------------------------------------------

export interface CategorySpending {
  categoryId: number;
  name: string;
  outflow: number;
  /** Number of outflow (purchase) rows only — refunds/inflows don't count as an "Nx" purchase. */
  count: number;
  /** 0..1 of the *group's* outflow, not of the period total. */
  share: number;
  /** Outflow for the same category over the comparison period; null for "all". */
  previousOutflow: number | null;
}

export interface GroupSpending {
  groupId: number;
  name: string;
  outflow: number;
  share: number;
  /** Number of outflow (purchase) rows only — refunds/inflows don't count as an "Nx" purchase. */
  count: number;
  /**
   * Outflow for the same group over the comparison period (previous month /
   * year, month-to-date aligned for a running period). Null for "all"; 0 when
   * there simply was no spend then.
   */
  previousOutflow: number | null;
  /**
   * Per-category breakdown, descending by outflow. A category is kept when it
   * had outflow in the period OR in the comparison period — a category that
   * went to zero is a change worth showing.
   */
  categories: CategorySpending[];
}

/** Outflow and outflow-row count per category over a date range, with the spending exclusions applied. */
function categoryOutflowBetween(
  dbi: DB,
  start: string | null,
  end: string | null,
  paymentCategoryIds: number[]
): { categoryId: number; groupId: number; name: string; outflow: number; count: number }[] {
  const conditions = [
    isNull(schema.transactions.transferAccountId),
    sql`${schema.transactions.categoryId} is not null`,
    ne(schema.accounts.type, "tracking"),
  ];
  if (start != null) conditions.push(gte(schema.transactions.date, start));
  if (end != null) conditions.push(sql`${schema.transactions.date} < ${end}`);
  if (paymentCategoryIds.length > 0) {
    conditions.push(notInArray(schema.transactions.categoryId, paymentCategoryIds));
  }

  return dbi
    .select({
      categoryId: schema.categories.id,
      groupId: schema.categories.groupId,
      name: schema.categories.name,
      outflow: sql<number>`coalesce(sum(case when ${schema.transactions.amount} < 0 then -${schema.transactions.amount} else 0 end), 0)`,
      count: sql<number>`coalesce(sum(case when ${schema.transactions.amount} < 0 then 1 else 0 end), 0)`,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .innerJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .where(and(...conditions))
    .groupBy(schema.categories.id)
    .all();
}

/**
 * Outflow per category group for the period, descending, each with its
 * per-category breakdown. Same exclusions as cashflow. `name` has a leading
 * "N. " ordering prefix stripped. A group's `share` is 0..1 of the period
 * total; a category's `share` is 0..1 of its *group*, so a group's categories
 * always sum to 1.
 *
 * `previousOutflow` (group and category alike) is the same figure over the
 * comparison period — see `comparisonBounds`, which trims the previous period
 * to the same day-of-month while the current one is still running. It is null
 * only for "all", which has no earlier period to compare against.
 */
export function getSpendingByGroup(
  period: StatsPeriod,
  dbi: DB = db,
  now: Date = new Date()
): { groups: GroupSpending[]; total: number; currency: string } {
  const currency = getCurrency(dbi);
  // Day-cut while the period is running, so the current figure covers the same
  // stretch of days as the comparison it sits next to.
  const current = currentBounds(period, now);
  const paymentCategoryIds = getPaymentCategoryIds(dbi);

  const rows = categoryOutflowBetween(dbi, current?.start ?? null, current?.end ?? null, paymentCategoryIds);

  const compare = comparisonBounds(period, now);
  const prevRows = compare == null ? null : categoryOutflowBetween(dbi, compare.start, compare.end, paymentCategoryIds);
  const prevByCategory = prevRows == null ? null : new Map(prevRows.map((r) => [r.categoryId, r.outflow] as const));
  const prevByGroup = new Map<number, number>();
  for (const r of prevRows ?? []) {
    prevByGroup.set(r.groupId, (prevByGroup.get(r.groupId) ?? 0) + r.outflow);
  }

  const groupNames = new Map(
    dbi
      .select({ id: schema.categoryGroups.id, name: schema.categoryGroups.name })
      .from(schema.categoryGroups)
      .all()
      .map((g) => [g.id, g.name] as const)
  );

  const byGroup = new Map<number, { outflow: number; count: number; rows: typeof rows }>();
  for (const r of rows) {
    const acc = byGroup.get(r.groupId) ?? { outflow: 0, count: 0, rows: [] };
    acc.outflow += r.outflow;
    acc.count += r.count;
    acc.rows.push(r);
    byGroup.set(r.groupId, acc);
  }

  // A group (or category) that was spent on last month and not at all this one
  // is the most interesting row on the page — "Restaurants CHF 0, −CHF 400 vs
  // Jul" is the whole point of the comparison. So carry those over as
  // zero-outflow rows rather than dropping them for having no current spend.
  const seen = new Set(rows.map((r) => r.categoryId));
  for (const r of prevRows ?? []) {
    if (seen.has(r.categoryId) || r.outflow <= 0) continue;
    const acc = byGroup.get(r.groupId) ?? { outflow: 0, count: 0, rows: [] };
    acc.rows.push({ ...r, outflow: 0, count: 0 });
    byGroup.set(r.groupId, acc);
  }

  const total = rows.reduce((s, r) => s + r.outflow, 0);

  const groups: GroupSpending[] = [...byGroup.entries()]
    .map(([groupId, acc]) => ({
      groupId,
      name: stripGroupPrefix(groupNames.get(groupId) ?? "(unknown)"),
      outflow: acc.outflow,
      count: acc.count,
      share: total > 0 ? acc.outflow / total : 0,
      previousOutflow: prevRows == null ? null : (prevByGroup.get(groupId) ?? 0),
      categories: acc.rows
        .filter((r) => r.outflow > 0 || (prevByCategory?.get(r.categoryId) ?? 0) > 0)
        .map((r) => ({
          categoryId: r.categoryId,
          name: r.name,
          outflow: r.outflow,
          count: r.count,
          share: acc.outflow > 0 ? r.outflow / acc.outflow : 0,
          previousOutflow: prevByCategory == null ? null : (prevByCategory.get(r.categoryId) ?? 0),
        }))
        .sort((a, b) => b.outflow - a.outflow),
    }))
    .filter((g) => g.outflow > 0 || (g.previousOutflow ?? 0) > 0)
    .sort((a, b) => b.outflow - a.outflow || (b.previousOutflow ?? 0) - (a.previousOutflow ?? 0));

  return { groups, total, currency };
}

/**
 * Total outflow (positive Rappen) for one category — or, with `categoryId ==
 * null`, across all categories — over the half-open date range [start, end),
 * with null bounds meaning "unbounded on that side".
 *
 * Deliberately matches `getCategoryStats`' semantics rather than this module's
 * spending definition, so a caller can put this number next to that page's
 * total without the two disagreeing:
 *
 * - Single category: every row filed under it on a non-tracking account,
 *   transfer legs INCLUDED (it's a ledger view of one category), and no
 *   payment-category exclusion — the caller already picked the category.
 * - All categories: uncategorized rows and transfer legs excluded, so the
 *   total equals the sum of the per-category totals.
 *
 * Exists because a period comparison needs *day* bounds, not a period: while
 * the current month is running, `comparisonBounds` cuts the previous month at
 * the same day, and a whole-previous-month figure would contradict the "so
 * far" the label promises.
 */
export function getCategoryOutflowBetween(
  categoryId: number | null,
  start: string | null,
  end: string | null,
  dbi: DB = db
): number {
  const conditions = [
    categoryId == null
      ? sql`${schema.transactions.categoryId} is not null`
      : eq(schema.transactions.categoryId, categoryId),
    ne(schema.accounts.type, "tracking"),
  ];
  if (categoryId == null) {
    conditions.push(isNull(schema.transactions.transferAccountId));
  }
  if (start != null) conditions.push(gte(schema.transactions.date, start));
  if (end != null) conditions.push(sql`${schema.transactions.date} < ${end}`);

  const row = dbi
    .select({
      outflow: sql<number>`coalesce(sum(case when ${schema.transactions.amount} < 0 then -${schema.transactions.amount} else 0 end), 0)`,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .where(and(...conditions))
    .get();

  return row?.outflow ?? 0;
}

// ---------------------------------------------------------------------------
// Largest transactions
// ---------------------------------------------------------------------------

export interface LargestTransaction {
  id: number;
  date: string;
  payee: string;
  /** Magnitude of the outflow, positive Rappen. */
  amount: number;
  categoryId: number;
  categoryName: string;
  accountId: number;
  accountName: string;
}

/**
 * The biggest single purchases in the period, descending by magnitude. Only
 * outflow rows (`amount < 0`), with exactly the spending exclusions used
 * everywhere else on this page: categorized, non-transfer, non-tracking
 * account, and never a credit-card payment category — so a CHF 2'000 card
 * payment can't outrank the actual purchases it settles.
 */
export function getLargestTransactions(
  period: StatsPeriod,
  limit: number = 8,
  dbi: DB = db,
  now: Date = new Date()
): { rows: LargestTransaction[]; currency: string } {
  const currency = getCurrency(dbi);
  // Cut at today while the period runs, so this list matches the totals above
  // it and can't be topped by a transaction dated later this month.
  const current = currentBounds(period, now);
  const start = current?.start ?? null;
  const end = current?.end ?? null;
  const paymentCategoryIds = getPaymentCategoryIds(dbi);

  const conditions = [
    sql`${schema.transactions.amount} < 0`,
    isNull(schema.transactions.transferAccountId),
    sql`${schema.transactions.categoryId} is not null`,
    ne(schema.accounts.type, "tracking"),
  ];
  if (start != null) conditions.push(gte(schema.transactions.date, start));
  if (end != null) conditions.push(sql`${schema.transactions.date} < ${end}`);
  if (paymentCategoryIds.length > 0) {
    conditions.push(notInArray(schema.transactions.categoryId, paymentCategoryIds));
  }

  const rows = dbi
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      payee: schema.transactions.payee,
      amount: schema.transactions.amount,
      categoryId: schema.categories.id,
      categoryName: schema.categories.name,
      accountId: schema.accounts.id,
      accountName: schema.accounts.name,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .innerJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .where(and(...conditions))
    .orderBy(sql`${schema.transactions.amount} asc`, sql`${schema.transactions.date} desc`)
    .limit(limit)
    .all();

  return {
    rows: rows.map((r) => ({
      ...r,
      payee: r.payee.trim() === "" ? "(no payee)" : r.payee,
      amount: -r.amount,
    })),
    currency,
  };
}

// ---------------------------------------------------------------------------
// Top payees
// ---------------------------------------------------------------------------

export interface PayeeSpending {
  payee: string;
  outflow: number;
  /** Number of outflow (purchase) rows only — refunds/inflows don't count as an "Nx" purchase. */
  count: number;
}

/** Top payees by outflow for the period. Same exclusions. Empty payee -> "(no payee)". */
export function getTopPayees(period: StatsPeriod, limit: number = 10, dbi: DB = db): PayeeSpending[] {
  const { start, end } = statsPeriodBounds(period);
  const paymentCategoryIds = getPaymentCategoryIds(dbi);

  const conditions = [
    isNull(schema.transactions.transferAccountId),
    sql`${schema.transactions.categoryId} is not null`,
    ne(schema.accounts.type, "tracking"),
  ];
  if (start != null) conditions.push(gte(schema.transactions.date, start));
  if (end != null) conditions.push(sql`${schema.transactions.date} < ${end}`);
  if (paymentCategoryIds.length > 0) {
    conditions.push(notInArray(schema.transactions.categoryId, paymentCategoryIds));
  }

  const rows = dbi
    .select({
      payee: schema.transactions.payee,
      outflow: sql<number>`coalesce(sum(case when ${schema.transactions.amount} < 0 then -${schema.transactions.amount} else 0 end), 0)`,
      count: sql<number>`coalesce(sum(case when ${schema.transactions.amount} < 0 then 1 else 0 end), 0)`,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .where(and(...conditions))
    .groupBy(schema.transactions.payee)
    .all();

  return rows
    .map((r) => ({
      payee: r.payee.trim() === "" ? "(no payee)" : r.payee,
      outflow: r.outflow,
      count: r.count,
    }))
    .filter((r) => r.outflow > 0)
    .sort((a, b) => b.outflow - a.outflow)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

export interface Trip {
  categoryId: number;
  name: string;
  /** Net outflow (outflow - inflow), Rappen. */
  total: number;
  outflow: number;
  inflow: number;
  count: number;
  firstDate: string;
  lastDate: string;
  days: number;
  costPerDay: number;
  /** Top 5. */
  topPayees: PayeeSpending[];
}

function getTopPayeesForCategory(dbi: DB, categoryId: number): PayeeSpending[] {
  const rows = dbi
    .select({
      payee: schema.transactions.payee,
      outflow: sql<number>`coalesce(sum(case when ${schema.transactions.amount} < 0 then -${schema.transactions.amount} else 0 end), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .where(and(eq(schema.transactions.categoryId, categoryId), ne(schema.accounts.type, "tracking")))
    .groupBy(schema.transactions.payee)
    .all();

  return rows
    .map((r) => ({
      payee: r.payee.trim() === "" ? "(no payee)" : r.payee,
      outflow: r.outflow,
      count: r.count,
    }))
    .filter((r) => r.outflow > 0)
    .sort((a, b) => b.outflow - a.outflow)
    .slice(0, 5);
}

/**
 * All-time, not period-scoped. Every category whose group name contains
 * "trips" (case-insensitive), hidden categories INCLUDED. Excludes tracking
 * accounts. Categories with no transactions are omitted. Sorted by lastDate
 * descending.
 */
export function getTrips(dbi: DB = db): { trips: Trip[]; currency: string } {
  const currency = getCurrency(dbi);

  const tripCategories = dbi
    .select({ id: schema.categories.id, name: schema.categories.name })
    .from(schema.categories)
    .innerJoin(schema.categoryGroups, eq(schema.categories.groupId, schema.categoryGroups.id))
    .where(
      and(
        sql`lower(${schema.categoryGroups.name}) like '%trips%'`,
        // Ongoing funds (e.g. "Travel Fund") carry a monthly funding target; actual trips don't.
        sql`not (${schema.categories.targetType} = 'monthly' and ${schema.categories.monthlyTarget} is not null)`,
      ),
    )
    .all();

  if (tripCategories.length === 0) return { trips: [], currency };

  const categoryIds = tripCategories.map((c) => c.id);
  const nameById = new Map(tripCategories.map((c) => [c.id, c.name] as const));

  const rows = dbi
    .select({
      categoryId: schema.transactions.categoryId,
      outflow: sql<number>`coalesce(sum(case when ${schema.transactions.amount} < 0 then -${schema.transactions.amount} else 0 end), 0)`,
      inflow: sql<number>`coalesce(sum(case when ${schema.transactions.amount} > 0 then ${schema.transactions.amount} else 0 end), 0)`,
      count: sql<number>`count(*)`,
      firstDate: sql<string>`min(${schema.transactions.date})`,
      lastDate: sql<string>`max(${schema.transactions.date})`,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .where(and(inArray(schema.transactions.categoryId, categoryIds), ne(schema.accounts.type, "tracking")))
    .groupBy(schema.transactions.categoryId)
    .all();

  const trips: Trip[] = rows
    .map((r) => {
      const categoryId = r.categoryId as number;
      const days = dayCountInclusive(r.firstDate, r.lastDate);
      const total = r.outflow - r.inflow;
      return {
        categoryId,
        name: nameById.get(categoryId) ?? "(unknown)",
        total,
        outflow: r.outflow,
        inflow: r.inflow,
        count: r.count,
        firstDate: r.firstDate,
        lastDate: r.lastDate,
        days,
        costPerDay: days > 0 ? Math.round(total / days) : 0,
        topPayees: getTopPayeesForCategory(dbi, categoryId),
      };
    })
    .sort((a, b) => b.lastDate.localeCompare(a.lastDate));

  return { trips, currency };
}

/**
 * Query functions backing the redesigned `/stats` page: net worth history,
 * monthly cashflow, spending-by-group, top payees and trips. Complements the
 * simpler category-drilldown stats in queries.ts (`getCategoryStats`).
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq, gte, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { BALANCE_ADJUSTMENT_PAYEE, getCurrency, STARTING_BALANCE_PAYEE } from "./queries";
import {
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

/** Inclusive day count between two YYYY-MM-DD dates. */
function dayCountInclusive(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const dbEnd = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((dbEnd - da) / msPerDay) + 1;
}

/** Category ids used as any account's credit-card payment category. */
function getPaymentCategoryIds(dbi: DB): number[] {
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
  currency: string;
}

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

  const dateConditions = [
    gte(schema.transactions.date, `${windowStart}-01`),
    sql`${schema.transactions.date} < ${`${monthKeyShift(windowEnd, 1)}-01`}`,
  ];

  const paymentCategoryIds = getPaymentCategoryIds(dbi);
  const spendingConditions = [
    isNull(schema.transactions.transferAccountId),
    sql`${schema.transactions.categoryId} is not null`,
    ne(schema.accounts.type, "tracking"),
    ...dateConditions,
  ];
  if (paymentCategoryIds.length > 0) {
    spendingConditions.push(notInArray(schema.transactions.categoryId, paymentCategoryIds));
  }

  const spendingRows = dbi
    .select({
      key: sql<string>`substr(${schema.transactions.date}, 1, 7)`,
      spending: sql<number>`coalesce(sum(case when ${schema.transactions.amount} < 0 then -${schema.transactions.amount} else 0 end), 0)`,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .where(and(...spendingConditions))
    .groupBy(sql`substr(${schema.transactions.date}, 1, 7)`)
    .all();
  const spendingByMonth = new Map(spendingRows.map((r) => [r.key, r.spending]));

  // Real income carries categoryId = NULL: assigning money to a category
  // happens from Ready to Assign, not on the deposit itself. Exclude the two
  // synthetic bookkeeping payees, which are account seeding / reconciliation
  // artifacts rather than income.
  const incomeRows = dbi
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
        ...dateConditions
      )
    )
    .groupBy(sql`substr(${schema.transactions.date}, 1, 7)`)
    .all();
  const incomeByMonth = new Map(incomeRows.map((r) => [r.key, r.income]));

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
  const income = periodMonthRows.reduce((s, m) => s + m.income, 0);
  const spending = periodMonthRows.reduce((s, m) => s + m.spending, 0);
  const net = income - spending;
  const savingsRate = income > 0 ? net / income : null;
  const avgSpendingPerMonth = periodMonthRows.length > 0 ? Math.round(spending / periodMonthRows.length) : 0;

  if (mode !== "all") {
    return { bucket: "month", entries: monthRows, income, spending, net, savingsRate, avgSpendingPerMonth, currency };
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

  return { bucket: "year", entries, income, spending, net, savingsRate, avgSpendingPerMonth, currency };
}

// ---------------------------------------------------------------------------
// Spending by group
// ---------------------------------------------------------------------------

export interface GroupSpending {
  groupId: number;
  name: string;
  outflow: number;
  share: number;
  /** Number of outflow (purchase) rows only — refunds/inflows don't count as an "Nx" purchase. */
  count: number;
}

/**
 * Outflow per category group for the period, descending. Same exclusions as
 * cashflow. `name` has a leading "N. " ordering prefix stripped. `share` is
 * 0..1 of the total.
 */
export function getSpendingByGroup(
  period: StatsPeriod,
  dbi: DB = db
): { groups: GroupSpending[]; total: number; currency: string } {
  const currency = getCurrency(dbi);
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
      groupId: schema.categories.groupId,
      outflow: sql<number>`coalesce(sum(case when ${schema.transactions.amount} < 0 then -${schema.transactions.amount} else 0 end), 0)`,
      count: sql<number>`coalesce(sum(case when ${schema.transactions.amount} < 0 then 1 else 0 end), 0)`,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .innerJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .where(and(...conditions))
    .groupBy(schema.categories.groupId)
    .all();

  const groupNames = new Map(
    dbi
      .select({ id: schema.categoryGroups.id, name: schema.categoryGroups.name })
      .from(schema.categoryGroups)
      .all()
      .map((g) => [g.id, g.name] as const)
  );

  const total = rows.reduce((s, r) => s + r.outflow, 0);

  const groups: GroupSpending[] = rows
    .map((r) => ({
      groupId: r.groupId,
      name: stripGroupPrefix(groupNames.get(r.groupId) ?? "(unknown)"),
      outflow: r.outflow,
      count: r.count,
      share: total > 0 ? r.outflow / total : 0,
    }))
    .filter((g) => g.outflow > 0)
    .sort((a, b) => b.outflow - a.outflow);

  return { groups, total, currency };
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
    .where(sql`lower(${schema.categoryGroups.name}) like '%trips%'`)
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

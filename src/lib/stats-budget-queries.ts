/**
 * Envelope-budget reporting for `/stats`: assigned vs spent, and the chronic
 * over-/under-funding detector.
 *
 * Where `stats-queries.ts` answers "where did the money go?" from the
 * transaction ledger, this module answers "did the plan hold?" — it only makes
 * sense against categories that carry an envelope, so it reads `assignments`
 * as the first-class input and puts spending next to it.
 *
 * All amounts are Rappen (minor-unit integers), never floats.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { isHiddenForMonth } from "./budget-math";
import { getCurrency } from "./queries";
import { monthKeyOf, monthKeyShift, monthKeysBetween, periodMode, type StatsPeriod } from "./stats-period";
import { getPaymentCategoryIds, stripGroupPrefix } from "./stats-queries";
import { db } from "@/db";
import * as schema from "@/db/schema";

type DB = BetterSQLite3Database<typeof schema>;

/** Category ids used as any account's credit-card payment category, as a set. */
function paymentCategoryIdSet(dbi: DB): Set<number> {
  return new Set(getPaymentCategoryIds(dbi));
}

/**
 * Ids of the groups the budget actually shows. A hidden group is gone from the
 * budget page entirely (`loadBudgetData` filters it out), so its categories
 * have no envelope anyone is looking at — they must not turn up in the
 * envelope report or in a "you keep overspending this" nudge either.
 */
function visibleGroupIds(dbi: DB): Set<number> {
  return new Set(
    dbi
      .select({ id: schema.categoryGroups.id })
      .from(schema.categoryGroups)
      .where(eq(schema.categoryGroups.hidden, false))
      .all()
      .map((g) => g.id)
  );
}

/**
 * Net activity per category over a half-open date range, as the budget defines
 * it (`computeCategoryActivity` in budget-math.ts): every categorized row on a
 * non-tracking account, sign preserved — so a refund reduces the month's spend
 * — INCLUDING categorized transfer legs, which the budget counts as activity
 * just like any other categorized row. This deliberately differs from the
 * cashflow/spending-by-group queries in stats-queries.ts, which drop transfers
 * because they aggregate cash movement rather than envelope activity.
 *
 * The credit-card payment-category feed that `computeCategoryActivity` also
 * applies is irrelevant here: payment categories are excluded from this report
 * entirely.
 *
 * Returned as raw net amounts (negative = spent); callers negate.
 */
function netActivityByCategoryMonth(
  dbi: DB,
  startDate: string,
  endDateExclusive: string
): { categoryId: number; month: string; net: number }[] {
  return dbi
    .select({
      categoryId: schema.transactions.categoryId,
      month: sql<string>`substr(${schema.transactions.date}, 1, 7)`,
      net: sql<number>`coalesce(sum(${schema.transactions.amount}), 0)`,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .where(
      and(
        sql`${schema.transactions.categoryId} is not null`,
        ne(schema.accounts.type, "tracking"),
        gte(schema.transactions.date, startDate),
        sql`${schema.transactions.date} < ${endDateExclusive}`
      )
    )
    .groupBy(schema.transactions.categoryId, sql`substr(${schema.transactions.date}, 1, 7)`)
    .all()
    .map((r) => ({ categoryId: r.categoryId as number, month: r.month, net: r.net }));
}

interface CategoryMetaRow {
  id: number;
  groupId: number;
  name: string;
  sort: number;
  hiddenFrom: string | null;
}

function loadCategories(dbi: DB): CategoryMetaRow[] {
  return dbi
    .select({
      id: schema.categories.id,
      groupId: schema.categories.groupId,
      name: schema.categories.name,
      sort: schema.categories.sort,
      hiddenFrom: schema.categories.hiddenFrom,
    })
    .from(schema.categories)
    .all();
}

/** The months a period covers, ascending. A running year/all-time stops at the current month. */
export function periodMonths(period: StatsPeriod, dbi: DB, now: Date): string[] {
  const mode = periodMode(period);
  const nowKey = monthKeyOf(now);
  if (mode === "month") return [period];
  if (mode === "year") {
    const year = Number(period);
    return monthKeysBetween(`${period}-01`, year === now.getFullYear() ? nowKey : `${period}-12`);
  }

  const firstTxn = dbi
    .select({ min: sql<string | null>`min(${schema.transactions.date})` })
    .from(schema.transactions)
    .get()?.min;
  const firstAssignment = dbi
    .select({ min: sql<string | null>`min(${schema.assignments.month})` })
    .from(schema.assignments)
    .get()?.min;
  const candidates = [firstTxn?.slice(0, 7), firstAssignment].filter((m): m is string => m != null);
  if (candidates.length === 0) return [nowKey];
  const first = candidates.reduce((a, b) => (a < b ? a : b));
  return monthKeysBetween(first < nowKey ? first : nowKey, nowKey);
}

// ---------------------------------------------------------------------------
// Assigned vs spent
// ---------------------------------------------------------------------------

export interface CategoryBudgetLine {
  categoryId: number;
  name: string;
  /** Hidden from the budget by the end of the period (still counted — hiding is cosmetic). */
  hidden: boolean;
  /** Sum of `assignments.amount` over the period's months, Rappen. */
  assigned: number;
  /** Net outflow over the period (outflows minus refunds), Rappen; negative if the category netted an inflow. */
  spent: number;
  /**
   * assigned - spent. Negative means the envelope came up short — but see
   * `isOverspent`: a NEGATIVE assignment (money moved back out of the
   * category) makes `difference` negative on its own, with nothing spent.
   */
  difference: number;
  /** spent / assigned, or null when nothing was assigned (no plan to measure against). */
  ratio: number | null;
}

export interface GroupBudgetLines {
  groupId: number;
  /** Group name with a leading "N. " ordering prefix stripped. */
  name: string;
  assigned: number;
  spent: number;
  difference: number;
  categories: CategoryBudgetLine[];
}

export interface AssignedVsSpent {
  period: StatsPeriod;
  /** The months covered, ascending. */
  months: string[];
  assigned: number;
  spent: number;
  difference: number;
  /** Categories that are overspent per `isOverspent`. */
  overspentCount: number;
  groups: GroupBudgetLines[];
  currency: string;
}

/**
 * Whether a line is actually overspent.
 *
 * Not simply `assigned - spent < 0`: an envelope can carry a NEGATIVE
 * assignment when money is moved back out of it (budget stats showed such a
 * line as "CHF 0.00 / CHF −800.00"). Spending nothing out of a category you
 * took CHF 800 back out of is not an overspend — there is no hole to plug. So
 * the plan a category is measured against is `max(assigned, 0)`.
 */
export function isOverspent(line: { assigned: number; spent: number }): boolean {
  return line.spent > Math.max(line.assigned, 0);
}

/**
 * Assigned vs spent per category for the period — the envelope-only report.
 *
 * Exclusions:
 * - Credit-card payment categories (`accounts.paymentCategoryId`): their
 *   "spend" is a derived bookkeeping feed, not a plan you can overspend.
 * - Categories in a hidden group — the budget page doesn't show the group at
 *   all, so its envelopes aren't a plan anyone is keeping.
 * - Categories hidden for the WHOLE period (`hiddenFrom` at or before the
 *   first month). A category hidden partway through still has real numbers
 *   for the months before it went away, so it stays, flagged `hidden`.
 * - Groups with no category lines left at all.
 *
 * Categories are sorted overspent-first (most negative difference), then by
 * spend descending — the report is read for problems first.
 */
export function getAssignedVsSpent(
  period: StatsPeriod,
  dbi: DB = db,
  now: Date = new Date()
): AssignedVsSpent {
  const currency = getCurrency(dbi);
  const months = periodMonths(period, dbi, now);
  const firstMonth = months[0];
  const lastMonth = months[months.length - 1];

  const paymentCategoryIds = paymentCategoryIdSet(dbi);
  const visibleGroups = visibleGroupIds(dbi);
  const categories = loadCategories(dbi).filter(
    (c) =>
      !paymentCategoryIds.has(c.id) &&
      visibleGroups.has(c.groupId) &&
      !isHiddenForMonth(c.hiddenFrom, firstMonth)
  );
  const categoryById = new Map(categories.map((c) => [c.id, c] as const));

  const assignedByCategory = new Map<number, number>();
  for (const row of dbi
    .select({ categoryId: schema.assignments.categoryId, amount: schema.assignments.amount })
    .from(schema.assignments)
    .where(inArray(schema.assignments.month, months))
    .all()) {
    if (!categoryById.has(row.categoryId)) continue;
    assignedByCategory.set(row.categoryId, (assignedByCategory.get(row.categoryId) ?? 0) + row.amount);
  }

  const spentByCategory = new Map<number, number>();
  for (const row of netActivityByCategoryMonth(dbi, `${firstMonth}-01`, `${monthKeyShift(lastMonth, 1)}-01`)) {
    if (!categoryById.has(row.categoryId)) continue;
    spentByCategory.set(row.categoryId, (spentByCategory.get(row.categoryId) ?? 0) - row.net);
  }

  const groupNames = new Map(
    dbi
      .select({ id: schema.categoryGroups.id, name: schema.categoryGroups.name, sort: schema.categoryGroups.sort })
      .from(schema.categoryGroups)
      .all()
      .map((g) => [g.id, g] as const)
  );

  const linesByGroup = new Map<number, CategoryBudgetLine[]>();
  for (const category of categories) {
    const assigned = assignedByCategory.get(category.id) ?? 0;
    const spent = spentByCategory.get(category.id) ?? 0;
    if (assigned === 0 && spent === 0) continue;
    const line: CategoryBudgetLine = {
      categoryId: category.id,
      name: category.name,
      hidden: isHiddenForMonth(category.hiddenFrom, lastMonth),
      assigned,
      spent,
      difference: assigned - spent,
      ratio: assigned === 0 ? null : spent / assigned,
    };
    const list = linesByGroup.get(category.groupId);
    if (list) list.push(line);
    else linesByGroup.set(category.groupId, [line]);
  }

  const groups: GroupBudgetLines[] = [...linesByGroup.entries()]
    .map(([groupId, lines]) => {
      const assigned = lines.reduce((s, l) => s + l.assigned, 0);
      const spent = lines.reduce((s, l) => s + l.spent, 0);
      return {
        groupId,
        name: stripGroupPrefix(groupNames.get(groupId)?.name ?? "(unknown)"),
        assigned,
        spent,
        difference: assigned - spent,
        // Overspent first (deepest hole first), then the biggest spenders.
        categories: lines.sort((a, b) => {
          const aOver = isOverspent(a);
          const bOver = isOverspent(b);
          if (aOver !== bOver) return aOver ? -1 : 1;
          if (aOver && bOver) return a.difference - b.difference;
          return b.spent - a.spent;
        }),
      };
    })
    // A group is dropped only when it has no lines at all. Filtering on the
    // sums would hide a group whose assigned and spent happen to cancel out —
    // exactly the group worth looking at.
    .filter((g) => g.categories.length > 0)
    // Biggest envelope OR biggest spend first: a group that assigned nothing
    // and spent a fortune belongs at the top, not below every funded group.
    .sort((a, b) => Math.max(b.assigned, b.spent) - Math.max(a.assigned, a.spent));

  const assigned = groups.reduce((s, g) => s + g.assigned, 0);
  const spent = groups.reduce((s, g) => s + g.spent, 0);
  const overspentCount = groups.reduce(
    (s, g) => s + g.categories.filter(isOverspent).length,
    0
  );

  return {
    period,
    months,
    assigned,
    spent,
    difference: assigned - spent,
    overspentCount,
    groups,
    currency,
  };
}

// ---------------------------------------------------------------------------
// Chronic over-/under-funding
// ---------------------------------------------------------------------------

/** Months of history the chronic detector looks at (full months only — the running month is excluded). */
export const CHRONIC_WINDOW_MONTHS = 6;
/** Months of overspend within the window before a category counts as chronically overspent. */
export const CHRONIC_OVER_MIN_HITS = 3;
/** Months of heavy underspend (of the months with an assignment) before a category counts as chronically over-funded. */
export const CHRONIC_UNDER_MIN_HITS = 4;
/** Spend-to-assigned ratio under which a month counts as heavily underspent. */
export const CHRONIC_UNDER_RATIO = 0.5;

export interface ChronicCategory {
  categoryId: number;
  name: string;
  /** Owning group, prefix stripped — the name alone ("Coffee") is often ambiguous. */
  groupName: string;
  /** Months in the window that tripped the rule. */
  monthsHit: number;
  /** Months the rule could apply to — months with an assignment, for both lists: a month with no envelope is not evidence. */
  monthsConsidered: number;
  /** Mean gap in the months that hit, Rappen, always positive (overspend for `over`, unspent for `under`). */
  averageGap: number;
}

/**
 * Categories where the plan and reality keep disagreeing, over the last
 * `CHRONIC_WINDOW_MONTHS` FULL months (the running month is excluded — half a
 * month of spend always looks under-funded).
 *
 * - `over`: spent more than assigned in at least `CHRONIC_OVER_MIN_HITS`
 *   months that HAD an assignment. The envelope is too small (or the habit
 *   too big); a month with no envelope at all isn't evidence either way.
 * - `under`: assigned money and spent less than `CHRONIC_UNDER_RATIO` of it in
 *   at least `CHRONIC_UNDER_MIN_HITS` months. Only months with an assignment
 *   count toward `monthsConsidered` — a category funded twice and left alone
 *   the rest of the window can't be "chronically" anything.
 *
 * Categories with no assignment at all in the window are skipped entirely
 * (there is no plan to compare against), as are payment categories, categories
 * in a hidden group, and categories hidden for the whole window. Each list is sorted by `averageGap`
 * descending and capped at 8 — this is a nudge list, not a ledger.
 */
export function getChronicCategories(
  dbi: DB = db,
  now: Date = new Date()
): { over: ChronicCategory[]; under: ChronicCategory[]; currency: string } {
  const currency = getCurrency(dbi);

  const lastFullMonth = monthKeyShift(monthKeyOf(now), -1);
  const firstMonth = monthKeyShift(lastFullMonth, -(CHRONIC_WINDOW_MONTHS - 1));
  const months = monthKeysBetween(firstMonth, lastFullMonth);

  const paymentCategoryIds = paymentCategoryIdSet(dbi);
  const visibleGroups = visibleGroupIds(dbi);
  const categories = loadCategories(dbi).filter(
    (c) =>
      !paymentCategoryIds.has(c.id) &&
      visibleGroups.has(c.groupId) &&
      !isHiddenForMonth(c.hiddenFrom, firstMonth)
  );
  const categoryById = new Map(categories.map((c) => [c.id, c] as const));

  const groupNames = new Map(
    dbi
      .select({ id: schema.categoryGroups.id, name: schema.categoryGroups.name })
      .from(schema.categoryGroups)
      .all()
      .map((g) => [g.id, stripGroupPrefix(g.name)] as const)
  );

  const key = (categoryId: number, month: string) => `${categoryId}|${month}`;

  const assigned = new Map<string, number>();
  for (const row of dbi
    .select({
      categoryId: schema.assignments.categoryId,
      month: schema.assignments.month,
      amount: schema.assignments.amount,
    })
    .from(schema.assignments)
    .where(inArray(schema.assignments.month, months))
    .all()) {
    if (!categoryById.has(row.categoryId)) continue;
    assigned.set(key(row.categoryId, row.month), row.amount);
  }

  const spent = new Map<string, number>();
  for (const row of netActivityByCategoryMonth(
    dbi,
    `${firstMonth}-01`,
    `${monthKeyShift(lastFullMonth, 1)}-01`
  )) {
    if (!categoryById.has(row.categoryId)) continue;
    spent.set(key(row.categoryId, row.month), -row.net);
  }

  const over: ChronicCategory[] = [];
  const under: ChronicCategory[] = [];

  for (const category of categories) {
    const monthsWithAssignment = months.filter((m) => (assigned.get(key(category.id, m)) ?? 0) !== 0);
    if (monthsWithAssignment.length === 0) continue;

    const base = {
      categoryId: category.id,
      name: category.name,
      groupName: groupNames.get(category.groupId) ?? "(unknown)",
    };

    // Only a month with an assignment can be "over": a month where nothing
    // was assigned has no envelope to bust, and counting it would flag every
    // category that is simply funded some months and spent in others.
    const overGaps: number[] = [];
    for (const month of months) {
      const a = assigned.get(key(category.id, month)) ?? 0;
      const s = spent.get(key(category.id, month)) ?? 0;
      if (a !== 0 && isOverspent({ assigned: a, spent: s })) overGaps.push(s - Math.max(a, 0));
    }
    if (overGaps.length >= CHRONIC_OVER_MIN_HITS) {
      over.push({
        ...base,
        monthsHit: overGaps.length,
        monthsConsidered: monthsWithAssignment.length,
        averageGap: Math.round(overGaps.reduce((x, y) => x + y, 0) / overGaps.length),
      });
    }

    const funded = months.filter((m) => (assigned.get(key(category.id, m)) ?? 0) > 0);
    const underGaps: number[] = [];
    for (const month of funded) {
      const a = assigned.get(key(category.id, month)) as number;
      const s = spent.get(key(category.id, month)) ?? 0;
      if (s < a * CHRONIC_UNDER_RATIO) underGaps.push(a - s);
    }
    if (underGaps.length >= CHRONIC_UNDER_MIN_HITS) {
      under.push({
        ...base,
        monthsHit: underGaps.length,
        monthsConsidered: funded.length,
        averageGap: Math.round(underGaps.reduce((x, y) => x + y, 0) / underGaps.length),
      });
    }
  }

  const rank = (list: ChronicCategory[]) => list.sort((a, b) => b.averageGap - a.averageGap).slice(0, 8);
  return { over: rank(over), under: rank(under), currency };
}

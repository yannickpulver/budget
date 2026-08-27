/**
 * Server-side budget query layer.
 *
 * Computes YNAB month snapshots with budget-math's compute-and-carry design and
 * caches them so a request never rewalks the full history. Every month snapshot
 * is memoized; the walk continues from the furthest month already computed.
 * Any write to transactions/assignments/categories must call
 * `invalidateBudgetCache()` to drop the cache. Writes from another process
 * (e.g. a migration script) are detected automatically via SQLite's
 * `data_version` pragma — see `SnapshotStore`.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  computeBalanceGoalStatus,
  computeCategoryActivityEntries,
  computeGoalStatus,
  computeMonthSnapshot,
  monthKey,
  nextMonthKey,
  prevMonthKey,
  type AccountInfo,
  type AccountType,
  type ActivityEntry,
  type ActivityTxnInput,
  type GoalStatus,
  type MonthSnapshot,
  type TargetType,
} from "./budget-math";
import {
  computeImportHash,
  resolveCategoryName,
  type ImportRowError,
  type ParsedImportRow,
} from "./csv-import";
import { formatMoney } from "./currency";
import { fetchYahooQuote, fxSymbol, isStale, toBudgetMinorUnits } from "./prices";
import { computeSwissquoteImportHash, type ParsedStatement, type StatementEntry } from "./swissquote-import";
import { monthKeyOf, monthShortLabel, monthSpan, periodMode, statsPeriodBounds, type StatsPeriod } from "./stats-period";
import { db, sqlite } from "@/db";
import * as schema from "@/db/schema";

type DB = BetterSQLite3Database<typeof schema>;

const DEFAULT_CURRENCY = "CHF";

export interface CategoryMeta {
  id: number;
  groupId: number;
  name: string;
  sort: number;
  hidden: boolean;
  monthlyTarget: number | null;
  targetType: TargetType;
  targetDate: string | null;
}

export interface GroupMeta {
  id: number;
  name: string;
  sort: number;
}

/**
 * Post-migration Ready to Assign alignment. YNAB's internal credit-card
 * mechanics make its Ready to Assign a path-dependent running ledger, while
 * ours is the identity `funds − Σ available`; historical credit-card
 * overspending YNAB routes to card debt, our overspend clamp charges to RTA.
 * The two therefore differ by a fixed amount after a migration even when every
 * category available matches. This flat offset (set once via `pnpm align:rta`)
 * is added to Ready to Assign from `month` onward — never to any category,
 * account balance, or the verification. See `SETTING_RTA_ADJUSTMENT`.
 */
export interface RtaAdjustment {
  /** Minor units, signed. */
  amount: number;
  /** YYYY-MM — applies to this month and every later month. */
  month: string;
}

export const SETTING_RTA_ADJUSTMENT = "rta_adjustment";
export const SETTING_RTA_ADJUSTMENT_MONTH = "rta_adjustment_month";
/** YYYY-MM from which category goals are evaluated — null means every month. See `setGoalsStartMonth`. */
export const SETTING_GOALS_START_MONTH = "goals_start_month";
const MONTH_RE = /^\d{4}-\d{2}$/;

export interface BudgetData {
  accounts: Map<number, AccountInfo>;
  /** Account id -> name, for display-only uses (e.g. "Payment: <account>" activity labels). */
  accountNames: Map<number, string>;
  groups: GroupMeta[];
  categories: CategoryMeta[];
  categoryIds: number[];
  assignmentsByMonth: Map<string, Map<number, number>>;
  /** Net assigned per month, across all categories — feeds "Assigned in the Future". */
  assignedTotalByMonth: Map<string, number>;
  txnsByMonth: Map<string, ActivityTxnInput[]>;
  earliestMonth: string | null;
  currency: string;
  rtaAdjustment: RtaAdjustment | null;
  /** YYYY-MM from which category goals apply; null = no cutoff (every month). */
  goalsStartMonth: string | null;
}

/** Read the whole budget into memory (one pass per cache lifetime). */
export function loadBudgetData(dbi: DB): BudgetData {
  const accountRows = dbi
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      type: schema.accounts.type,
      paymentCategoryId: schema.accounts.paymentCategoryId,
    })
    .from(schema.accounts)
    .all();

  const accounts = new Map<number, AccountInfo>(
    accountRows.map((a) => [
      a.id,
      { id: a.id, type: a.type, paymentCategoryId: a.paymentCategoryId ?? null },
    ])
  );
  const accountNames = new Map<number, string>(accountRows.map((a) => [a.id, a.name]));

  const groups = dbi
    .select({
      id: schema.categoryGroups.id,
      name: schema.categoryGroups.name,
      sort: schema.categoryGroups.sort,
    })
    .from(schema.categoryGroups)
    .where(eq(schema.categoryGroups.hidden, false))
    .all();

  const categories: CategoryMeta[] = dbi
    .select({
      id: schema.categories.id,
      groupId: schema.categories.groupId,
      name: schema.categories.name,
      sort: schema.categories.sort,
      hidden: schema.categories.hidden,
      monthlyTarget: schema.categories.monthlyTarget,
      targetType: schema.categories.targetType,
      targetDate: schema.categories.targetDate,
    })
    .from(schema.categories)
    .all();

  const assignmentsByMonth = new Map<string, Map<number, number>>();
  const assignedTotalByMonth = new Map<string, number>();
  for (const row of dbi.select().from(schema.assignments).all()) {
    let monthMap = assignmentsByMonth.get(row.month);
    if (!monthMap) {
      monthMap = new Map();
      assignmentsByMonth.set(row.month, monthMap);
    }
    monthMap.set(row.categoryId, row.amount);
    assignedTotalByMonth.set(row.month, (assignedTotalByMonth.get(row.month) ?? 0) + row.amount);
  }

  const txnsByMonth = new Map<string, ActivityTxnInput[]>();
  let earliestMonth: string | null = null;
  const txnRows = dbi
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      payee: schema.transactions.payee,
      accountId: schema.transactions.accountId,
      categoryId: schema.transactions.categoryId,
      amount: schema.transactions.amount,
      transferAccountId: schema.transactions.transferAccountId,
    })
    .from(schema.transactions)
    .all();
  for (const row of txnRows) {
    const month = monthKey(row.date);
    if (earliestMonth === null || month < earliestMonth) earliestMonth = month;
    let list = txnsByMonth.get(month);
    if (!list) {
      list = [];
      txnsByMonth.set(month, list);
    }
    list.push({
      id: row.id,
      date: row.date,
      payee: row.payee,
      accountId: row.accountId,
      categoryId: row.categoryId ?? null,
      amount: row.amount,
      transferAccountId: row.transferAccountId ?? null,
    });
  }

  for (const month of assignmentsByMonth.keys()) {
    if (earliestMonth === null || month < earliestMonth) earliestMonth = month;
  }

  const settingsRows = dbi.select().from(schema.settings).all();
  const getSetting = (key: string) => settingsRows.find((s) => s.key === key)?.value;

  return {
    accounts,
    accountNames,
    groups,
    categories,
    categoryIds: categories.map((c) => c.id),
    assignmentsByMonth,
    assignedTotalByMonth,
    txnsByMonth,
    earliestMonth,
    currency: getSetting("currency") ?? DEFAULT_CURRENCY,
    rtaAdjustment: parseRtaAdjustment(
      getSetting(SETTING_RTA_ADJUSTMENT),
      getSetting(SETTING_RTA_ADJUSTMENT_MONTH)
    ),
    goalsStartMonth: parseGoalsStartMonth(getSetting(SETTING_GOALS_START_MONTH)),
  };
}

/**
 * Parse the two persisted settings into an adjustment, tolerating missing or
 * malformed values (returns null) so a hand-edited settings row can never make
 * the budget throw.
 */
export function parseRtaAdjustment(
  amountRaw: string | undefined,
  month: string | undefined
): RtaAdjustment | null {
  if (amountRaw == null || month == null) return null;
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || !MONTH_RE.test(month)) return null;
  return { amount: Math.round(amount), month };
}

/** Parse the persisted goals-start-month setting, tolerating missing/malformed values (returns null). */
export function parseGoalsStartMonth(month: string | undefined): string | null {
  if (month == null || !MONTH_RE.test(month)) return null;
  return month;
}

interface Cursor {
  month: string | null;
  prevAvailable: Map<number, number>;
  cumulativeFunds: number;
}

const ZERO_SNAPSHOT: MonthSnapshot = {
  categories: new Map(),
  readyToAssign: 0,
  cumulativeOnBudgetFunds: 0,
};

/**
 * Net assigned across every month strictly after `month` — YNAB's "Assigned in
 * the Future", subtracted from that month's Ready to Assign.
 *
 * Applies to every month, past or present: browsing back to a past month must
 * not resurrect money that was later assigned forward, or Ready to Assign
 * would appear to "reappear" simply because you navigated backward.
 */
export function assignedAfterMonth(
  assignedTotalByMonth: Map<string, number>,
  month: string
): number {
  let total = 0;
  for (const [m, amount] of assignedTotalByMonth) {
    if (m > month) total += amount;
  }
  return total;
}

/**
 * Incremental snapshot cache. `getSnapshot(M)` returns the memoized month or
 * walks forward from the furthest computed month, caching each step.
 *
 * `getDataVersion` (defaults to a no-op that never changes) lets callers wire
 * in SQLite's `PRAGMA data_version`, which changes only when a *different*
 * connection commits a write — never for writes on this same connection,
 * since those already call `invalidate()` explicitly. This is how a stale
 * cache from another process (e.g. `pnpm migrate:ynab` running against the
 * same DB file while the server is up) gets picked up without a restart.
 */
export class SnapshotStore {
  private data: BudgetData | null = null;
  private dataVersion: number | null = null;
  private snapshots = new Map<string, MonthSnapshot>();
  private cursor: Cursor = {
    month: null,
    prevAvailable: new Map(),
    cumulativeFunds: 0,
  };

  constructor(
    private loader: () => BudgetData,
    private getDataVersion: () => number = () => 0
  ) {}

  getData(): BudgetData {
    if (this.data && this.getDataVersion() !== this.dataVersion) {
      this.invalidate();
    }
    if (!this.data) {
      this.dataVersion = this.getDataVersion();
      this.data = this.loader();
    }
    return this.data;
  }

  invalidate(): void {
    this.data = null;
    this.dataVersion = null;
    this.snapshots = new Map();
    this.cursor = { month: null, prevAvailable: new Map(), cumulativeFunds: 0 };
  }

  getSnapshot(month: string): MonthSnapshot {
    const data = this.getData();
    if (data.earliestMonth === null || month < data.earliestMonth) {
      return ZERO_SNAPSHOT;
    }
    const cached = this.snapshots.get(month);
    if (cached) return cached;

    let m =
      this.cursor.month === null ? data.earliestMonth : nextMonthKey(this.cursor.month);
    while (m <= month) {
      const adj = data.rtaAdjustment;
      const readyToAssignAdjustment = adj && m >= adj.month ? adj.amount : 0;
      const snapshot = computeMonthSnapshot({
        categoryIds: data.categoryIds,
        prevAvailable: this.cursor.prevAvailable,
        assignedByCategory: data.assignmentsByMonth.get(m) ?? new Map(),
        monthTransactions: data.txnsByMonth.get(m) ?? [],
        cumulativeOnBudgetFundsThroughPrevMonth: this.cursor.cumulativeFunds,
        accounts: data.accounts,
        readyToAssignAdjustment,
        assignedInFutureMonths: assignedAfterMonth(data.assignedTotalByMonth, m),
      });
      this.snapshots.set(m, snapshot);
      this.cursor = {
        month: m,
        prevAvailable: new Map(
          Array.from(snapshot.categories, ([id, s]) => [id, s.available])
        ),
        cumulativeFunds: snapshot.cumulativeOnBudgetFunds,
      };
      if (m === month) break;
      m = nextMonthKey(m);
    }
    return this.snapshots.get(month) ?? ZERO_SNAPSHOT;
  }
}

// App-wide singleton backed by the real database. `data_version` detects
// writes committed by other processes against the same DB file (e.g. a
// migration script run alongside `pnpm dev`) so the cache self-invalidates
// instead of serving stale data until the server restarts.
const store = new SnapshotStore(
  () => loadBudgetData(db),
  () => sqlite.pragma("data_version", { simple: true }) as number
);

export function invalidateBudgetCache(): void {
  store.invalidate();
}

export interface CategoryView {
  id: number;
  name: string;
  assigned: number;
  activity: number;
  available: number;
  monthlyTarget: number | null;
  targetType: TargetType;
  /** YYYY-MM the balance goal aims to reach the target by; null = no deadline or a monthly goal. */
  targetDate: string | null;
  goal: GoalStatus | null;
  /** Needs funding this month — drives the amber row and the "Needs funding" filter. For monthly goals this is `!goal.met`; for balance goals it's the behind-pace check. */
  underfunded: boolean;
  /** True when the goal was explicitly funded this month (the "Fund" button) — met via the flag, resettable. */
  goalFunded: boolean;
  /** Transactions (and, for credit-card payment categories, feed entries) behind `activity` this month — sums to it. */
  activityTransactions: ActivityEntry[];
  /**
   * Mean magnitude of net activity (minor units, always positive) over the
   * trailing 6 full months before the displayed month, counting only months
   * within the data range. Null when there's nothing worth showing: fewer
   * than 6-months-of-data-in-range with zero net activity, a rounded average
   * of 0, or a credit-card payment category (its activity is derived).
   */
  avgSpend: number | null;
}

export interface GroupView {
  id: number;
  name: string;
  categories: CategoryView[];
}

export interface BudgetView {
  month: string;
  months: string[];
  currency: string;
  readyToAssign: number;
  totalUnderfunded: number;
  groups: GroupView[];
  /** Set when a post-migration RTA alignment is in effect for this month (for a subtle header hint). */
  rtaAdjustment: RtaAdjustment | null;
}

/** YYYY-MM for the given date (defaults to now). */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** Inclusive list of month keys from `start` to `end`. */
export function monthRange(start: string, end: string): string[] {
  const months: string[] = [];
  let m = start;
  while (m <= end) {
    months.push(m);
    if (m === end) break;
    m = nextMonthKey(m);
  }
  return months;
}

const AVG_SPEND_WINDOW_MONTHS = 6;

/**
 * Builds a per-category `avgSpend` lookup for `getBudgetView`: the mean
 * magnitude of net activity over the trailing 6 full months before `month`
 * (excluding `month` itself), counting only months within the data range.
 * Reuses `store`'s memoized snapshots — no new computation for months
 * already walked to reach `month`.
 */
function buildAvgSpendComputer(
  month: string,
  data: BudgetData,
  store: SnapshotStore
): (categoryId: number) => number | null {
  const paymentCategoryIds = new Set<number>();
  for (const account of data.accounts.values()) {
    if (account.paymentCategoryId != null) paymentCategoryIds.add(account.paymentCategoryId);
  }

  const windowSnapshots: MonthSnapshot[] = [];
  let m = month;
  for (let i = 0; i < AVG_SPEND_WINDOW_MONTHS; i++) {
    m = prevMonthKey(m);
    if (data.earliestMonth != null && m >= data.earliestMonth) {
      windowSnapshots.push(store.getSnapshot(m));
    }
  }

  return (categoryId: number): number | null => {
    if (paymentCategoryIds.has(categoryId) || windowSnapshots.length === 0) return null;
    let sum = 0;
    for (const snapshot of windowSnapshots) {
      sum += snapshot.categories.get(categoryId)?.activity ?? 0;
    }
    const magnitude = Math.round(Math.abs(sum / windowSnapshots.length));
    return Math.round(magnitude / 100) === 0 ? null : magnitude;
  };
}

/** Build everything the budget page renders for one month. */
export function getBudgetView(month: string): BudgetView {
  const data = store.getData();
  const snapshot = store.getSnapshot(month);
  // Ready to Assign is one budget-wide number, identical no matter which month
  // you're browsing — YNAB never shows a stale historical reconstruction for
  // a past month. Only categories/activity are month-specific; the walk to
  // the current month is already memoized by SnapshotStore.
  const readyToAssign =
    month < currentMonth() ? store.getSnapshot(currentMonth()).readyToAssign : snapshot.readyToAssign;

  const end = nextMonthKey(currentMonth());
  const start = data.earliestMonth ?? currentMonth();
  const months = monthRange(start < end ? start : end, end);

  const categoriesByGroup = new Map<number, CategoryMeta[]>();
  for (const category of data.categories) {
    const list = categoriesByGroup.get(category.groupId);
    if (list) list.push(category);
    else categoriesByGroup.set(category.groupId, [category]);
  }

  const activityEntriesByCategory = computeCategoryActivityEntries(
    data.txnsByMonth.get(month) ?? [],
    data.accounts,
    data.accountNames
  );

  const computeAvgSpend = buildAvgSpendComputer(month, data, store);

  // Categories whose monthly goal was explicitly funded this month — stays met
  // even if the money is later spent or reallocated out (see `computeGoalStatus`).
  const fundedCategoryIds = new Set(
    db
      .select({ categoryId: schema.assignments.categoryId })
      .from(schema.assignments)
      .where(and(eq(schema.assignments.month, month), eq(schema.assignments.goalFunded, true)))
      .all()
      .map((r) => r.categoryId)
  );

  // The user only started tracking goals from `goalsStartMonth` onward —
  // earlier months must render as plain, goal-free categories (no amber
  // "needs funding", no met/unmet chip), without touching the stored target.
  const goalsActive = data.goalsStartMonth == null || month >= data.goalsStartMonth;

  let totalUnderfunded = 0;
  const groups: GroupView[] = [...data.groups]
    .sort((a, b) => a.sort - b.sort)
    .map((group) => {
      const cats = (categoriesByGroup.get(group.id) ?? [])
        .filter((category) => !category.hidden)
        .sort((a, b) => a.sort - b.sort)
        .map((category): CategoryView => {
          const cell =
            snapshot.categories.get(category.id) ?? {
              assigned: 0,
              activity: 0,
              available: 0,
            };
          const goalFunded = goalsActive && fundedCategoryIds.has(category.id);
          let goal: GoalStatus | null;
          let underfunded: boolean;
          if (!goalsActive || category.monthlyTarget == null) {
            goal = null;
            underfunded = false;
          } else if (category.targetType === "balance") {
            const balance = computeBalanceGoalStatus({
              target: category.monthlyTarget,
              targetDate: category.targetDate,
              month,
              assigned: cell.assigned,
              available: cell.available,
              funded: goalFunded,
            });
            goal = { met: balance.met, remaining: balance.remaining };
            underfunded = balance.underfunded;
          } else {
            goal = computeGoalStatus(category.monthlyTarget, cell.assigned, goalFunded);
            underfunded = goal != null && !goal.met;
          }
          if (underfunded && goal) totalUnderfunded += goal.remaining;
          const activityTransactions = [...(activityEntriesByCategory.get(category.id) ?? [])].sort(
            (a, b) => a.date.localeCompare(b.date) || a.id - b.id
          );
          return {
            id: category.id,
            name: category.name,
            assigned: cell.assigned,
            activity: cell.activity,
            available: cell.available,
            monthlyTarget: goalsActive ? category.monthlyTarget : null,
            targetType: category.targetType,
            targetDate: goalsActive ? category.targetDate : null,
            goal,
            underfunded,
            goalFunded,
            activityTransactions,
            avgSpend: computeAvgSpend(category.id),
          };
        });
      return { id: group.id, name: group.name, categories: cats };
    })
    .filter((group) => group.categories.length > 0);

  const adj = data.rtaAdjustment;
  return {
    month,
    months,
    currency: data.currency,
    readyToAssign,
    totalUnderfunded,
    groups,
    rtaAdjustment: adj && month >= adj.month ? adj : null,
  };
}

/**
 * Budget page filter chips ("Needs funding" / "Negative"). Pure over
 * `GroupView[]` so the page can filter server-side without recomputing the
 * snapshot, and so the matching logic is unit-testable without a database.
 */
export const BUDGET_FILTER_KEYS = ["underfunded", "negative"] as const;
export type BudgetFilterKey = (typeof BUDGET_FILTER_KEYS)[number];

/** "Needs funding" = same condition as the row's underfunded amber state. */
export function categoryMatchesFilter(category: CategoryView, filter: BudgetFilterKey): boolean {
  switch (filter) {
    case "underfunded":
      return category.underfunded;
    case "negative":
      return category.available < 0;
  }
}

/** Count of categories (across all groups) matching `filter` — for the chip's count badge. */
export function countBudgetFilterMatches(groups: GroupView[], filter: BudgetFilterKey): number {
  let count = 0;
  for (const group of groups) {
    for (const category of group.categories) {
      if (categoryMatchesFilter(category, filter)) count++;
    }
  }
  return count;
}

/**
 * Keeps only categories matching at least one of `filters` (union), dropping
 * groups left with none. Returns `groups` unchanged when `filters` is empty
 * so group totals (derived from `categories` by the caller) stay exact.
 */
export function filterGroupViews(groups: GroupView[], filters: BudgetFilterKey[]): GroupView[] {
  if (filters.length === 0) return groups;
  return groups
    .map((group) => ({
      ...group,
      categories: group.categories.filter((c) => filters.some((f) => categoryMatchesFilter(c, f))),
    }))
    .filter((group) => group.categories.length > 0);
}

/**
 * The adjustment that snaps Ready to Assign at `month` from its current value
 * to `targetMinor`. `currentRta` is the app's RTA for that month *with any
 * existing adjustment already applied*, and `appliedAdjustment` is how much of
 * that came from an existing adjustment — subtracting it recovers the raw
 * (unadjusted) RTA, so re-aligning is idempotent rather than compounding.
 */
export function computeAlignmentAdjustment(
  targetMinor: number,
  currentRta: number,
  appliedAdjustment: number
): number {
  return targetMinor - (currentRta - appliedAdjustment);
}

/** Upsert the two RTA-alignment settings. Caller must `invalidateBudgetCache()`. */
export function setRtaAdjustment(dbi: DB, amount: number, month: string): void {
  upsertSetting(dbi, SETTING_RTA_ADJUSTMENT, String(Math.round(amount)));
  upsertSetting(dbi, SETTING_RTA_ADJUSTMENT_MONTH, month);
}

/** Upsert the goals-start-month setting. Caller must `invalidateBudgetCache()`. */
export function setGoalsStartMonth(dbi: DB, month: string): void {
  upsertSetting(dbi, SETTING_GOALS_START_MONTH, month);
}

function upsertSetting(dbi: DB, key: string, value: string): void {
  dbi
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();
}

/**
 * Add `delta` to a category's assignment amount for `month`, inserting the
 * row if it doesn't exist yet. Used by the YNAB migration's payment-category
 * reconciliation (see `src/lib/reconciliation.ts`) to book a correction as
 * an additional assignment rather than overwriting Available directly.
 */
export function adjustAssignment(dbi: DB, month: string, categoryId: number, delta: number): void {
  const existing = dbi
    .select({ amount: schema.assignments.amount })
    .from(schema.assignments)
    .where(and(eq(schema.assignments.month, month), eq(schema.assignments.categoryId, categoryId)))
    .get();
  const amount = (existing?.amount ?? 0) + delta;
  if (existing) {
    dbi
      .update(schema.assignments)
      .set({ amount })
      .where(and(eq(schema.assignments.month, month), eq(schema.assignments.categoryId, categoryId)))
      .run();
  } else {
    dbi.insert(schema.assignments).values({ month, categoryId, amount }).run();
  }
}

/**
 * Accounts sidebar, account register and transaction/transfer mutations.
 *
 * These functions take an explicit `dbi` (falling back to the app-wide `db`)
 * so the transfer logic can be exercised against an in-memory SQLite fixture
 * in tests, the same way `loadBudgetData`/`SnapshotStore` are tested above.
 */

export function getCurrency(dbi: DB): string {
  const row = dbi
    .select()
    .from(schema.settings)
    .all()
    .find((s) => s.key === "currency");
  return row?.value ?? DEFAULT_CURRENCY;
}

export interface AccountBalance {
  id: number;
  name: string;
  type: AccountType;
  closed: boolean;
  icon: string | null;
  /** Month (YYYY-MM) from which this account is hidden in the sidebar; null = never. */
  hiddenFrom: string | null;
  balance: number;
}

/** Balance per account via one SQL aggregate (SUM amount), not a per-account walk. */
export function listAccountBalances(dbi: DB = db): AccountBalance[] {
  const balances = dbi
    .select({
      accountId: schema.transactions.accountId,
      balance: sql<number>`coalesce(sum(${schema.transactions.amount}), 0)`,
    })
    .from(schema.transactions)
    .groupBy(schema.transactions.accountId)
    .all();
  const balanceById = new Map(balances.map((b) => [b.accountId, b.balance]));

  const accountRows = dbi
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      type: schema.accounts.type,
      closed: schema.accounts.closed,
      icon: schema.accounts.icon,
      hiddenFrom: schema.accounts.hiddenFrom,
      sort: schema.accounts.sort,
    })
    .from(schema.accounts)
    .all();

  return [...accountRows]
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
    .map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      closed: a.closed,
      icon: a.icon,
      hiddenFrom: a.hiddenFrom,
      balance: balanceById.get(a.id) ?? 0,
    }));
}

export interface SidebarData {
  currency: string;
  budget: AccountBalance[];
  giftcards: AccountBalance[];
  tracking: AccountBalance[];
  closed: AccountBalance[];
  /** Includes giftcards (see `giftcardsTotal`) — they're on-budget funds. */
  budgetTotal: number;
  giftcardsTotal: number;
  trackingTotal: number;
  netWorth: number;
}

function sumBalances(accounts: AccountBalance[]): number {
  return accounts.reduce((total, a) => total + a.balance, 0);
}

/** Everything the sidebar renders: grouped accounts, subtotals, net worth. */
export function getSidebarData(dbi: DB = db): SidebarData {
  const all = listAccountBalances(dbi);
  const open = all.filter((a) => !a.closed);
  const closed = all.filter((a) => a.closed);
  const budget = open.filter((a) => a.type !== "tracking" && a.type !== "giftcard");
  const giftcards = open.filter((a) => a.type === "giftcard");
  const tracking = open.filter((a) => a.type === "tracking");
  const giftcardsTotal = sumBalances(giftcards);
  // Giftcards render in their own compact section but are on-budget funds,
  // so they're folded into the Budget subtotal (and, via it, net worth).
  const budgetTotal = sumBalances(budget) + giftcardsTotal;
  const trackingTotal = sumBalances(tracking);

  return {
    currency: getCurrency(dbi),
    budget,
    giftcards,
    tracking,
    closed,
    budgetTotal,
    giftcardsTotal,
    trackingTotal,
    netWorth: budgetTotal + trackingTotal,
  };
}

export interface AccountDetail {
  id: number;
  name: string;
  type: AccountType;
  closed: boolean;
  icon: string | null;
  currency: string;
  balance: number;
  clearedBalance: number;
  unclearedBalance: number;
  transactionCount: number;
  /** For giftcards: the category new transactions default to. Null otherwise. */
  linkedCategoryId: number | null;
}

/** Header data for the account page: balance, cleared/uncleared split, txn count. */
export function getAccountDetail(id: number, dbi: DB = db): AccountDetail | null {
  const account = dbi
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, id))
    .get();
  if (!account) return null;

  const agg = dbi
    .select({
      balance: sql<number>`coalesce(sum(${schema.transactions.amount}), 0)`,
      clearedBalance: sql<number>`coalesce(sum(case when ${schema.transactions.cleared} then ${schema.transactions.amount} else 0 end), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.accountId, id))
    .get();

  const balance = agg?.balance ?? 0;
  const clearedBalance = agg?.clearedBalance ?? 0;

  return {
    id: account.id,
    name: account.name,
    type: account.type,
    closed: account.closed,
    icon: account.icon,
    currency: getCurrency(dbi),
    balance,
    clearedBalance,
    unclearedBalance: balance - clearedBalance,
    transactionCount: agg?.count ?? 0,
    linkedCategoryId: account.linkedCategoryId,
  };
}

export interface RegisterRow {
  id: number;
  date: string;
  payee: string;
  categoryId: number | null;
  categoryName: string | null;
  memo: string;
  amount: number;
  cleared: boolean;
  transferAccountId: number | null;
  transferAccountName: string | null;
}

export interface RegisterPage {
  rows: RegisterRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Rows in this account with no category and no transfer, ignoring the current search/filter. */
  uncategorizedTotal: number;
}

const REGISTER_PAGE_SIZE = 100;

function registerRowMatches(row: RegisterRow, search: string): boolean {
  if (row.payee.toLowerCase().includes(search)) return true;
  if (row.memo.toLowerCase().includes(search)) return true;
  if (row.categoryName?.toLowerCase().includes(search)) return true;
  if (row.transferAccountName?.toLowerCase().includes(search)) return true;
  const amountText = formatMoney(row.amount).toLowerCase();
  return amountText.includes(search) || amountText.replace(/'/g, "").includes(search);
}

/**
 * Paginated, searchable transaction register for one account (newest first).
 * Filtering runs server-side against the account's full row set (at most a
 * few thousand rows for a personal budget — cheap to hold in memory) rather
 * than shipping rows to the client to filter.
 */
export function getAccountRegister(
  accountId: number,
  opts: { search?: string; page?: number; uncategorizedOnly?: boolean } = {},
  dbi: DB = db
): RegisterPage {
  const page = Math.max(1, opts.page ?? 1);
  const search = opts.search?.trim().toLowerCase() ?? "";

  const transferAccount = alias(schema.accounts, "transfer_account");
  const rows: RegisterRow[] = dbi
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      payee: schema.transactions.payee,
      categoryId: schema.transactions.categoryId,
      categoryName: schema.categories.name,
      memo: schema.transactions.memo,
      amount: schema.transactions.amount,
      cleared: schema.transactions.cleared,
      transferAccountId: schema.transactions.transferAccountId,
      transferAccountName: transferAccount.name,
    })
    .from(schema.transactions)
    .leftJoin(schema.categories, eq(schema.transactions.categoryId, schema.categories.id))
    .leftJoin(transferAccount, eq(schema.transactions.transferAccountId, transferAccount.id))
    .where(eq(schema.transactions.accountId, accountId))
    .orderBy(desc(schema.transactions.date), desc(schema.transactions.id))
    .all()
    .map((r) => ({
      ...r,
      categoryName: r.categoryName ?? null,
      transferAccountName: r.transferAccountName ?? null,
    }));

  // Transfers carry no category by design, so including them would bury the rows
  // that actually need attention.
  const scoped = opts.uncategorizedOnly
    ? rows.filter((r) => r.categoryId == null && r.transferAccountId == null)
    : rows;
  const filtered = search === "" ? scoped : scoped.filter((r) => registerRowMatches(r, search));
  const start = (page - 1) * REGISTER_PAGE_SIZE;

  return {
    rows: filtered.slice(start, start + REGISTER_PAGE_SIZE),
    total: filtered.length,
    page,
    pageSize: REGISTER_PAGE_SIZE,
    uncategorizedTotal: rows.filter((r) => r.categoryId == null && r.transferAccountId == null).length,
  };
}

/**
 * Distinct payees across all non-transfer transactions, ranked most-used then
 * most-recent first, for the register's payee autocomplete. Capped so the whole
 * list can ship to the client and be filtered there as the user types.
 */
export function getPayeeSuggestions(dbi: DB = db): string[] {
  return dbi
    .select({ payee: schema.transactions.payee })
    .from(schema.transactions)
    .where(and(isNull(schema.transactions.transferAccountId), ne(schema.transactions.payee, "")))
    .groupBy(schema.transactions.payee)
    .orderBy(desc(sql`count(*)`), desc(sql`max(${schema.transactions.date})`))
    .limit(300)
    .all()
    .map((r) => r.payee);
}

export interface CategoryOption {
  id: number;
  name: string;
}

export interface CategoryGroupOption {
  id: number;
  name: string;
  categories: CategoryOption[];
}

/** Visible groups/categories for the transaction category dropdown. */
export function getCategoryOptions(dbi: DB = db): CategoryGroupOption[] {
  const groups = dbi
    .select({ id: schema.categoryGroups.id, name: schema.categoryGroups.name, sort: schema.categoryGroups.sort })
    .from(schema.categoryGroups)
    .where(eq(schema.categoryGroups.hidden, false))
    .all();
  const categoryRows = dbi
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      groupId: schema.categories.groupId,
      sort: schema.categories.sort,
    })
    .from(schema.categories)
    .where(eq(schema.categories.hidden, false))
    .all();

  const byGroup = new Map<number, CategoryOption[]>();
  for (const c of [...categoryRows].sort((a, b) => a.sort - b.sort)) {
    const list = byGroup.get(c.groupId) ?? [];
    list.push({ id: c.id, name: c.name });
    byGroup.set(c.groupId, list);
  }

  return [...groups]
    .sort((a, b) => a.sort - b.sort)
    .map((g) => ({ id: g.id, name: g.name, categories: byGroup.get(g.id) ?? [] }))
    .filter((g) => g.categories.length > 0);
}

/**
 * Category settings (`/settings/categories`): create/rename/hide/delete for
 * groups and categories, plus the empty-DB starter-category seed.
 */

const DEFAULT_CATEGORY_SEED: { group: string; categories: string[] }[] = [
  { group: "Spending", categories: ["Groceries", "Eating Out", "Transport", "Fun", "Home"] },
  { group: "Bills", categories: ["Rent", "Health Insurance", "Subscriptions"] },
  { group: "Saving", categories: ["Emergency Fund", "Travel"] },
];

/**
 * Seed a small, generic starter category set the first time an account is
 * created against an empty categories table. Only ever runs once — as soon
 * as any category exists (seeded or user-created), it's a no-op. Everything
 * seeded is a plain, renameable/hideable/deletable category — no special
 * treatment.
 */
export function seedDefaultCategoriesIfEmpty(dbi: DB): void {
  const existing = dbi.select({ id: schema.categories.id }).from(schema.categories).all();
  if (existing.length > 0) return;

  let groupSort = 0;
  for (const { group, categories } of DEFAULT_CATEGORY_SEED) {
    const groupResult = dbi
      .insert(schema.categoryGroups)
      .values({ name: group, sort: groupSort++ })
      .run();
    const groupId = Number(groupResult.lastInsertRowid);
    let catSort = 0;
    for (const name of categories) {
      dbi.insert(schema.categories).values({ groupId, name, sort: catSort++ }).run();
    }
  }
}

export interface CategoryAdmin {
  id: number;
  name: string;
  sort: number;
  hidden: boolean;
  monthlyTarget: number | null;
  /** Used by a transaction, an assignment, or as a credit account's payment category — delete is blocked, hide only. */
  referenced: boolean;
}

export interface CategoryGroupAdmin {
  id: number;
  name: string;
  sort: number;
  hidden: boolean;
  categories: CategoryAdmin[];
}

/** Full groups+categories tree (including hidden) for the settings page. */
export function listCategoryGroupsAdmin(dbi: DB = db): CategoryGroupAdmin[] {
  const groups = dbi.select().from(schema.categoryGroups).all();
  const categoryRows = dbi.select().from(schema.categories).all();

  const referencedIds = new Set<number>();
  for (const row of dbi
    .select({ categoryId: schema.transactions.categoryId })
    .from(schema.transactions)
    .all()) {
    if (row.categoryId != null) referencedIds.add(row.categoryId);
  }
  for (const row of dbi.select({ categoryId: schema.assignments.categoryId }).from(schema.assignments).all()) {
    referencedIds.add(row.categoryId);
  }
  for (const row of dbi
    .select({
      paymentCategoryId: schema.accounts.paymentCategoryId,
      linkedCategoryId: schema.accounts.linkedCategoryId,
    })
    .from(schema.accounts)
    .all()) {
    if (row.paymentCategoryId != null) referencedIds.add(row.paymentCategoryId);
    if (row.linkedCategoryId != null) referencedIds.add(row.linkedCategoryId);
  }

  const byGroup = new Map<number, CategoryAdmin[]>();
  for (const c of [...categoryRows].sort((a, b) => a.sort - b.sort)) {
    const list = byGroup.get(c.groupId) ?? [];
    list.push({
      id: c.id,
      name: c.name,
      sort: c.sort,
      hidden: c.hidden,
      monthlyTarget: c.monthlyTarget,
      referenced: referencedIds.has(c.id),
    });
    byGroup.set(c.groupId, list);
  }

  return [...groups]
    .sort((a, b) => a.sort - b.sort)
    .map((g) => ({
      id: g.id,
      name: g.name,
      sort: g.sort,
      hidden: g.hidden,
      categories: byGroup.get(g.id) ?? [],
    }));
}

export function createCategoryGroup(dbi: DB, name: string): number {
  const maxSort = dbi
    .select({ maxSort: sql<number | null>`max(${schema.categoryGroups.sort})` })
    .from(schema.categoryGroups)
    .get();
  const sort = (maxSort?.maxSort ?? -1) + 1;
  const result = dbi.insert(schema.categoryGroups).values({ name, sort }).run();
  return Number(result.lastInsertRowid);
}

export function renameCategoryGroup(dbi: DB, id: number, name: string): void {
  dbi.update(schema.categoryGroups).set({ name }).where(eq(schema.categoryGroups.id, id)).run();
}

export function setCategoryGroupHidden(dbi: DB, id: number, hidden: boolean): void {
  dbi.update(schema.categoryGroups).set({ hidden }).where(eq(schema.categoryGroups.id, id)).run();
}

export type SettingsResult = { ok: true } | { ok: false; error: string };

/** Groups can only be deleted while empty — hide it (or move/delete its categories first) otherwise. */
export function deleteCategoryGroup(dbi: DB, id: number): SettingsResult {
  const count = dbi
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.groupId, id))
    .all().length;
  if (count > 0) return { ok: false, error: "Remove its categories first, or hide the group instead." };
  dbi.delete(schema.categoryGroups).where(eq(schema.categoryGroups.id, id)).run();
  return { ok: true };
}

/** Reindex every group's `sort` to its position in `orderedGroupIds` (0..n), in one transaction. */
export function reorderCategoryGroups(dbi: DB, orderedGroupIds: number[]): void {
  dbi.transaction((tx) => {
    orderedGroupIds.forEach((id, sort) => {
      tx.update(schema.categoryGroups).set({ sort }).where(eq(schema.categoryGroups.id, id)).run();
    });
  });
}

export function createCategory(dbi: DB, groupId: number, name: string): number {
  const maxSort = dbi
    .select({ maxSort: sql<number | null>`max(${schema.categories.sort})` })
    .from(schema.categories)
    .where(eq(schema.categories.groupId, groupId))
    .get();
  const sort = (maxSort?.maxSort ?? -1) + 1;
  const result = dbi.insert(schema.categories).values({ groupId, name, sort }).run();
  return Number(result.lastInsertRowid);
}

export function renameCategory(dbi: DB, id: number, name: string): void {
  dbi.update(schema.categories).set({ name }).where(eq(schema.categories.id, id)).run();
}

export function setCategoryHidden(dbi: DB, id: number, hidden: boolean): void {
  dbi.update(schema.categories).set({ hidden }).where(eq(schema.categories.id, id)).run();
}

function isCategoryReferenced(dbi: DB, id: number): boolean {
  const txn = dbi
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(eq(schema.transactions.categoryId, id))
    .limit(1)
    .all();
  if (txn.length > 0) return true;
  const assignment = dbi
    .select({ categoryId: schema.assignments.categoryId })
    .from(schema.assignments)
    .where(eq(schema.assignments.categoryId, id))
    .limit(1)
    .all();
  if (assignment.length > 0) return true;
  const linked = dbi
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(or(eq(schema.accounts.paymentCategoryId, id), eq(schema.accounts.linkedCategoryId, id)))
    .limit(1)
    .all();
  return linked.length > 0;
}

/** Categories can only be deleted while unreferenced (no transactions/assignments/payment link) — hide otherwise. */
export function deleteCategory(dbi: DB, id: number): SettingsResult {
  if (isCategoryReferenced(dbi, id)) {
    return { ok: false, error: "Category is in use — hide it instead of deleting." };
  }
  dbi.delete(schema.categories).where(eq(schema.categories.id, id)).run();
  return { ok: true };
}

/**
 * Reindex `orderedCategoryIds` to `groupId` with `sort` 0..n, in one
 * transaction. Also doubles as "move category to another group": pass the
 * target group's full resulting id list (including the moved category) and
 * every row's `groupId` is set to match, moving it in the same write.
 */
export function reorderCategories(dbi: DB, groupId: number, orderedCategoryIds: number[]): void {
  dbi.transaction((tx) => {
    orderedCategoryIds.forEach((id, sort) => {
      tx.update(schema.categories).set({ sort, groupId }).where(eq(schema.categories.id, id)).run();
    });
  });
}

/** Move a category to another group, appended at the end (its old group's sort values are left as-is — deliberately not reindexed, since gaps don't affect ordering). */
export function moveCategoryToGroup(dbi: DB, id: number, groupId: number): void {
  const maxSort = dbi
    .select({ maxSort: sql<number | null>`max(${schema.categories.sort})` })
    .from(schema.categories)
    .where(eq(schema.categories.groupId, groupId))
    .get();
  const sort = (maxSort?.maxSort ?? -1) + 1;
  dbi.update(schema.categories).set({ groupId, sort }).where(eq(schema.categories.id, id)).run();
}

export interface AccountRef {
  id: number;
  name: string;
  type: AccountType;
  closed: boolean;
}

/** Lean account list (no balances) for name/type lookups — e.g. resolving a transfer leg's other account. */
export function listAccounts(dbi: DB = db): AccountRef[] {
  return dbi
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      type: schema.accounts.type,
      closed: schema.accounts.closed,
      sort: schema.accounts.sort,
    })
    .from(schema.accounts)
    .all()
    .sort((a, b) => a.sort - b.sort)
    .map(({ id, name, type, closed }) => ({ id, name, type, closed }));
}

/**
 * Reindex `orderedIds`' sort to their position (0..n), in one transaction —
 * mirrors `reorderCategories`. Only touches the passed ids (typically one
 * sidebar section, e.g. Budget); other accounts' sort values are left as-is,
 * which is fine since each section is filtered by type before being sorted,
 * so cross-section sort collisions don't affect ordering.
 */
export function reorderAccounts(dbi: DB, orderedIds: number[]): void {
  dbi.transaction((tx) => {
    orderedIds.forEach((id, sort) => {
      tx.update(schema.accounts).set({ sort }).where(eq(schema.accounts.id, id)).run();
    });
  });
}

export type TransferTarget = Omit<AccountRef, "closed">;

/** Open accounts eligible as a transfer target (everything but the current account). */
export function getTransferTargets(excludeAccountId: number, dbi: DB = db): TransferTarget[] {
  return listAccounts(dbi)
    .filter((a) => !a.closed && a.id !== excludeAccountId)
    .map(({ id, name, type }) => ({ id, name, type }));
}

export interface CreateAccountInput {
  name: string;
  type: AccountType;
  /** Minor units. 0 = no starting-balance transaction created. */
  startingBalance: number;
  /** ISO date for the starting-balance transaction. */
  date: string;
}

/** Category group that auto-created giftcard categories are filed under. */
const GIFTCARD_GROUP_NAME = "Giftcards";

/** The single "Giftcards" category group, created on first use. */
function getOrCreateGiftcardGroup(dbi: DB): number {
  const existing = dbi
    .select({ id: schema.categoryGroups.id })
    .from(schema.categoryGroups)
    .where(eq(schema.categoryGroups.name, GIFTCARD_GROUP_NAME))
    .get();
  return existing?.id ?? createCategoryGroup(dbi, GIFTCARD_GROUP_NAME);
}

/**
 * Give a giftcard account its own budget category (same name, under the
 * shared "Giftcards" group), link the account to it so new spend defaults
 * there, and assign `balance` to it for `month` so the funds are earmarked —
 * leaving Ready to Assign unchanged. Called on giftcard creation and when an
 * existing account is converted to a giftcard.
 */
function attachGiftcardCategory(
  dbi: DB,
  accountId: number,
  name: string,
  balance: number,
  month: string
): void {
  const groupId = getOrCreateGiftcardGroup(dbi);
  const categoryId = createCategory(dbi, groupId, name);
  dbi
    .update(schema.accounts)
    .set({ linkedCategoryId: categoryId })
    .where(eq(schema.accounts.id, accountId))
    .run();
  if (balance !== 0) adjustAssignment(dbi, month, categoryId, balance);
}

/**
 * Create an account and, if non-zero, a "Starting Balance" transaction.
 * Uncategorized (categoryId null) for every account type — for on-budget
 * accounts that lands in Ready to Assign; tracking accounts aren't budgeted
 * so it's simply uncategorized. Also seeds the starter category set the
 * first time ever an account is created against an empty categories table.
 *
 * Giftcards additionally get a matching budget category (same name, under a
 * dedicated "Giftcards" group) with their starting balance moved out of
 * Ready to Assign and into that category — so the funds are earmarked and
 * ready to spend, leaving Ready to Assign unchanged.
 */
export function createAccount(dbi: DB, input: CreateAccountInput): number {
  seedDefaultCategoriesIfEmpty(dbi);

  const maxSort = dbi
    .select({ maxSort: sql<number | null>`max(${schema.accounts.sort})` })
    .from(schema.accounts)
    .get();
  const sort = (maxSort?.maxSort ?? -1) + 1;

  const result = dbi
    .insert(schema.accounts)
    .values({ name: input.name, type: input.type, sort })
    .run();
  const accountId = Number(result.lastInsertRowid);

  if (input.startingBalance !== 0) {
    dbi
      .insert(schema.transactions)
      .values({
        accountId,
        date: input.date,
        payee: STARTING_BALANCE_PAYEE,
        categoryId: null,
        memo: "",
        amount: input.startingBalance,
        cleared: true,
      })
      .run();
  }

  if (input.type === "giftcard") {
    // Assign in the starting-balance transaction's month so its inflow to
    // Ready to Assign is exactly offset there, netting RTA to zero.
    attachGiftcardCategory(dbi, accountId, input.name, input.startingBalance, input.date.slice(0, 7));
  }

  return accountId;
}

export function renameAccount(dbi: DB, id: number, name: string): void {
  dbi.update(schema.accounts).set({ name }).where(eq(schema.accounts.id, id)).run();
}

export function setAccountClosed(dbi: DB, id: number, closed: boolean): void {
  dbi.update(schema.accounts).set({ closed }).where(eq(schema.accounts.id, id)).run();
}

/**
 * Switching between on-budget and tracking legitimately changes Ready to
 * Assign — that's the point (e.g. a mis-detected investment account can be
 * flipped to tracking). No special-casing here.
 *
 * Converting to a giftcard mirrors giftcard creation: the account gets its
 * own linked budget category with its current balance assigned there. Idempotent
 * — an account already linked (e.g. converted away and back) keeps its category.
 */
export function setAccountType(dbi: DB, id: number, type: AccountType): void {
  dbi.update(schema.accounts).set({ type }).where(eq(schema.accounts.id, id)).run();

  if (type === "giftcard") {
    const account = dbi.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
    if (account && account.linkedCategoryId == null) {
      const balance = getAccountDetail(id, dbi)?.balance ?? 0;
      attachGiftcardCategory(dbi, id, account.name, balance, currentMonth());
    }
  }
}

/** Sets or clears (`null`) the emoji override shown instead of the type's default icon. */
export function setAccountIcon(dbi: DB, id: number, icon: string | null): void {
  dbi.update(schema.accounts).set({ icon }).where(eq(schema.accounts.id, id)).run();
}

/** Sets (YYYY-MM) or clears (`null`) the month from which the account is hidden in the sidebar. */
export function setAccountHiddenFrom(dbi: DB, id: number, month: string | null): void {
  dbi.update(schema.accounts).set({ hiddenFrom: month }).where(eq(schema.accounts.id, id)).run();
}

export function deleteAccount(dbi: DB, id: number): void {
  dbi.delete(schema.accounts).where(eq(schema.accounts.id, id)).run();
}

export interface TransactionInput {
  accountId: number;
  date: string;
  payee: string;
  categoryId: number | null;
  memo: string;
  amount: number;
  cleared: boolean;
}

/** Create a plain (non-transfer) transaction. */
export function createTransaction(dbi: DB, input: TransactionInput): number {
  const result = dbi.insert(schema.transactions).values(input).run();
  return Number(result.lastInsertRowid);
}

type TransferRow = typeof schema.transactions.$inferSelect;

/**
 * Find the mirror leg of a transfer. Resolved primarily by `transferPairId`
 * — a stable id stamped on both legs at creation time — so two same-day,
 * same-amount transfers between the same account pair never cross-match.
 * Falls back to the old (account, other account, date, amount) heuristic
 * only for legacy rows that predate the pair id column.
 */
function findMirrorLeg(dbi: DB, leg: TransferRow): TransferRow | null {
  if (leg.transferAccountId == null) return null;

  if (leg.transferPairId != null) {
    const byPairId = dbi
      .select()
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.transferPairId, leg.transferPairId),
          sql`${schema.transactions.id} != ${leg.id}`
        )
      )
      .get();
    if (byPairId) return byPairId;
  }

  return (
    dbi
      .select()
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.accountId, leg.transferAccountId),
          eq(schema.transactions.transferAccountId, leg.accountId),
          eq(schema.transactions.date, leg.date),
          eq(schema.transactions.amount, -leg.amount)
        )
      )
      .get() ?? null
  );
}

export interface TransactionEditInput {
  date: string;
  payee: string;
  categoryId: number | null;
  memo: string;
  amount: number;
  cleared: boolean;
}

/**
 * Update a transaction. If it's a transfer leg, date/memo/amount/cleared are
 * synced to the mirror leg (amount negated); payee and category stay
 * per-leg (only one side of a transfer ever carries a category — see
 * `createTransfer`).
 */
export function updateTransaction(dbi: DB, id: number, input: TransactionEditInput): void {
  const original = dbi.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get();
  if (!original) return;
  const isTransfer = original.transferAccountId != null;

  dbi
    .update(schema.transactions)
    .set({
      date: input.date,
      payee: isTransfer ? original.payee : input.payee,
      categoryId: input.categoryId,
      memo: input.memo,
      amount: input.amount,
      cleared: input.cleared,
    })
    .where(eq(schema.transactions.id, id))
    .run();

  if (isTransfer) {
    const mirror = findMirrorLeg(dbi, original);
    if (mirror) {
      dbi
        .update(schema.transactions)
        .set({ date: input.date, memo: input.memo, amount: -input.amount, cleared: input.cleared })
        .where(eq(schema.transactions.id, mirror.id))
        .run();
    }
  }
}

/** Delete a transaction. If it's a transfer leg, its mirror leg is deleted too. */
export function deleteTransaction(dbi: DB, id: number): void {
  const original = dbi.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get();
  if (!original) return;

  if (original.transferAccountId != null) {
    const mirror = findMirrorLeg(dbi, original);
    if (mirror) dbi.delete(schema.transactions).where(eq(schema.transactions.id, mirror.id)).run();
  }
  dbi.delete(schema.transactions).where(eq(schema.transactions.id, id)).run();
}

/** Flip a transaction's cleared flag. Syncs the mirror leg for transfers. */
export function toggleTransactionCleared(dbi: DB, id: number): void {
  const original = dbi.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get();
  if (!original) return;
  const cleared = !original.cleared;

  dbi.update(schema.transactions).set({ cleared }).where(eq(schema.transactions.id, id)).run();

  if (original.transferAccountId != null) {
    const mirror = findMirrorLeg(dbi, original);
    if (mirror) dbi.update(schema.transactions).set({ cleared }).where(eq(schema.transactions.id, mirror.id)).run();
  }
}

export interface CreateTransferInput {
  fromAccountId: number;
  toAccountId: number;
  date: string;
  /** Magnitude, minor units — sign is derived per leg. */
  amount: number;
  memo: string;
  cleared: boolean;
  /**
   * Only meaningful (and required by the UI) when exactly one side is a
   * tracking account: YNAB categorizes the on-budget leg of a transfer to/from
   * tracking money, since that money is leaving/entering the budget. Both-
   * on-budget transfers carry no category on either leg.
   */
  categoryId: number | null;
}

/** Create both legs of a transfer atomically, linked via `transferAccountId`. */
export function createTransfer(dbi: DB, input: CreateTransferInput): { fromId: number; toId: number } {
  const accountRows = dbi
    .select({ id: schema.accounts.id, type: schema.accounts.type })
    .from(schema.accounts)
    .all();
  const typeById = new Map(accountRows.map((a) => [a.id, a.type]));
  const fromIsTracking = typeById.get(input.fromAccountId) === "tracking";
  const toIsTracking = typeById.get(input.toAccountId) === "tracking";

  // Category only applies to the on-budget leg when the other leg is tracking.
  const fromCategoryId = !fromIsTracking && toIsTracking ? input.categoryId : null;
  const toCategoryId = !toIsTracking && fromIsTracking ? input.categoryId : null;

  const amount = Math.abs(input.amount);
  const transferPairId = crypto.randomUUID();

  const fromResult = dbi
    .insert(schema.transactions)
    .values({
      accountId: input.fromAccountId,
      date: input.date,
      payee: "Transfer",
      categoryId: fromCategoryId,
      memo: input.memo,
      amount: -amount,
      cleared: input.cleared,
      transferAccountId: input.toAccountId,
      transferPairId,
    })
    .run();

  const toResult = dbi
    .insert(schema.transactions)
    .values({
      accountId: input.toAccountId,
      date: input.date,
      payee: "Transfer",
      categoryId: toCategoryId,
      memo: input.memo,
      amount,
      cleared: input.cleared,
      transferAccountId: input.fromAccountId,
      transferPairId,
    })
    .run();

  return { fromId: Number(fromResult.lastInsertRowid), toId: Number(toResult.lastInsertRowid) };
}

/** Only the on-budget leg of a transfer carries a category, when the other leg is tracking — see `createTransfer`. */
function transferLegCategory(
  legIsTracking: boolean,
  otherIsTracking: boolean,
  categoryId: number | null
): number | null {
  return !legIsTracking && otherIsTracking ? categoryId : null;
}

/**
 * YNAB-style payee-driven transfers: turn a plain transaction into a transfer
 * (or retarget an existing one). Both cases run against the row identified by
 * `id`, so callers never need to know upfront which one applies.
 *
 * Plain row: stamps a fresh `transferPairId`, moves the row's payee text to
 * its memo (only if the memo is empty — the same convention CSV import
 * uses), sets payee to "Transfer", and inserts the mirror leg in
 * `toAccountId`. Category is kept only when `toAccountId` is a tracking
 * account and this account isn't (see `transferLegCategory`).
 *
 * Existing transfer row: the mirror leg is moved from its current account to
 * `toAccountId` and the category rule is reapplied for the new pairing.
 */
export function convertTransactionToTransfer(dbi: DB, id: number, toAccountId: number): void {
  const original = dbi.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get();
  if (!original) throw new Error("Transaction not found.");
  if (toAccountId === original.accountId) {
    throw new Error("Choose a different account to transfer to.");
  }

  const accountRows = dbi
    .select({ id: schema.accounts.id, type: schema.accounts.type })
    .from(schema.accounts)
    .all();
  const typeById = new Map(accountRows.map((a) => [a.id, a.type]));
  const fromIsTracking = typeById.get(original.accountId) === "tracking";
  const toIsTracking = typeById.get(toAccountId) === "tracking";

  if (original.transferAccountId != null) {
    const mirror = findMirrorLeg(dbi, original);
    const carriedCategoryId = original.categoryId ?? mirror?.categoryId ?? null;

    dbi
      .update(schema.transactions)
      .set({
        transferAccountId: toAccountId,
        categoryId: transferLegCategory(fromIsTracking, toIsTracking, carriedCategoryId),
      })
      .where(eq(schema.transactions.id, id))
      .run();

    if (mirror) {
      dbi
        .update(schema.transactions)
        .set({
          accountId: toAccountId,
          transferAccountId: original.accountId,
          categoryId: transferLegCategory(toIsTracking, fromIsTracking, carriedCategoryId),
        })
        .where(eq(schema.transactions.id, mirror.id))
        .run();
    }
    return;
  }

  const transferPairId = crypto.randomUUID();
  const memo = original.memo || original.payee;

  dbi
    .update(schema.transactions)
    .set({
      payee: "Transfer",
      memo,
      categoryId: transferLegCategory(fromIsTracking, toIsTracking, original.categoryId),
      transferAccountId: toAccountId,
      transferPairId,
    })
    .where(eq(schema.transactions.id, id))
    .run();

  dbi
    .insert(schema.transactions)
    .values({
      accountId: toAccountId,
      date: original.date,
      payee: "Transfer",
      categoryId: transferLegCategory(toIsTracking, fromIsTracking, original.categoryId),
      memo,
      amount: -original.amount,
      cleared: original.cleared,
      transferAccountId: original.accountId,
      transferPairId,
    })
    .run();
}

/**
 * The reverse of `convertTransactionToTransfer`: deletes the mirror leg and
 * turns this row back into a plain transaction with the given payee.
 * Category is left `null` — the user picks a fresh one, same as any new
 * transaction.
 */
export function convertTransferToTransaction(dbi: DB, id: number, payee: string): void {
  const original = dbi.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get();
  if (!original) throw new Error("Transaction not found.");
  if (original.transferAccountId == null) throw new Error("Not a transfer.");

  const mirror = findMirrorLeg(dbi, original);
  if (mirror) dbi.delete(schema.transactions).where(eq(schema.transactions.id, mirror.id)).run();

  dbi
    .update(schema.transactions)
    .set({ payee, categoryId: null, transferAccountId: null, transferPairId: null })
    .where(eq(schema.transactions.id, id))
    .run();
}

/**
 * Ongoing per-account CSV import: preview + commit.
 *
 * Preview matches each row's category name against existing (visible)
 * categories and flags duplicates; commit inserts the rows the user kept
 * checked. See `src/lib/csv-import.ts` for the pure CSV parsing/hashing.
 */

export interface ImportPreviewRow {
  line: number;
  date: string;
  payee: string;
  memo: string;
  amount: number;
  categoryId: number | null;
  /** Display name — matched category, "Ready to Assign", raw unmatched name, or null. */
  categoryName: string | null;
  /**
   * `"duplicate"` — already in the account. `"revised"` — the same transaction
   * at a slightly different amount, restated by the bank after the export was
   * taken; committing it updates the existing row in place.
   */
  status: "new" | "duplicate" | "revised";
  /** The transaction this row revises, set only when `status` is `"revised"`. */
  existingId: number | null;
  /** That transaction's current amount, for showing the delta. */
  existingAmount: number | null;
  importHash: string;
  /** Counterpart account for a transfer row, or null for an ordinary transaction. */
  transferAccountId: number | null;
  /** Counterpart account's name, for display. */
  transferAccountName: string | null;
}

/**
 * How far an amount may move and still count as the same transaction: 1% of the
 * booked amount, capped at CHF 1.00. Card issuers restate foreign-currency rows
 * by a rappen or two once the final exchange rate settles, days after the
 * statement was exported. That is tiny against a CHF 327 car rental but a much
 * larger share of a CHF 3.38 subscription, so the limit is proportional with an
 * absolute ceiling.
 */
const REVISION_MAX_RAPPEN = 100;
const REVISION_MAX_FRACTION = 0.01;

interface RevisionCandidate {
  id: number;
  amount: number;
}

/**
 * The one existing transaction that `amount` revises, or null.
 *
 * Requires a single candidate within tolerance: with two same-day charges from
 * one merchant there is no way to tell which the bank restated, and guessing
 * would overwrite a real transaction. Ambiguity resolves to null, so the row
 * imports as new and the user sees both.
 */
function findRevisionTarget(candidates: RevisionCandidate[], amount: number): RevisionCandidate | null {
  const withinTolerance = candidates.filter((c) => {
    if (Math.sign(c.amount) !== Math.sign(amount)) return false;
    const diff = Math.abs(amount - c.amount);
    if (diff === 0) return false; // an exact match is a duplicate, handled by the triple
    return diff <= Math.min(REVISION_MAX_RAPPEN, Math.abs(c.amount) * REVISION_MAX_FRACTION);
  });
  return withinTolerance.length === 1 ? withinTolerance[0] : null;
}

/** Transfer rows are stored with this payee, matching `createTransfer`. */
const TRANSFER_PAYEE = "Transfer";

/**
 * A transfer row's effective payee. Transfers are stored as `"Transfer"` like
 * every other transfer in the app, so a re-import dedups against transfers that
 * were entered by hand — those carry no usable `import_hash`, leaving the
 * date+amount+payee triple as the only thing that can match. The CSV's own payee
 * text (e.g. "Card Services AG") would defeat that, so it moves to the memo.
 */
function transferPayee(row: { payee: string; transferAccountName: string | null }): string {
  return row.transferAccountName == null ? row.payee : TRANSFER_PAYEE;
}

function transferMemo(row: { payee: string; memo: string; transferAccountName: string | null }): string {
  if (row.transferAccountName == null) return row.memo;
  return row.memo || row.payee;
}

/**
 * Resolve `Transfer` column names to account ids, case-insensitively. Returns
 * one error per row whose counterpart can't be used, so the caller can reject
 * the whole file rather than silently importing a transfer as plain spending —
 * that would leave the counterpart account short and distort Ready to Assign.
 */
export function findTransferAccountErrors(
  dbi: DB,
  accountId: number,
  rows: ParsedImportRow[]
): ImportRowError[] {
  if (!rows.some((r) => r.transferAccountName != null)) return [];
  const accounts = dbi
    .select({ id: schema.accounts.id, name: schema.accounts.name })
    .from(schema.accounts)
    .all();
  const idByName = new Map(accounts.map((a) => [a.name.toLowerCase(), a.id]));
  const errors: ImportRowError[] = [];
  for (const row of rows) {
    if (row.transferAccountName == null) continue;
    const target = idByName.get(row.transferAccountName.toLowerCase());
    if (target == null) {
      errors.push({ line: row.line, message: `Unknown transfer account "${row.transferAccountName}".` });
    } else if (target === accountId) {
      errors.push({ line: row.line, message: `Transfer account "${row.transferAccountName}" is this account.` });
    }
  }
  return errors;
}

/**
 * Build the import preview: match categories by name (case-insensitive,
 * first match wins), resolve `Transfer` counterpart accounts, and flag
 * duplicates against existing transactions in this account (by import_hash or
 * by date+amount+payee) and against earlier rows in the same file.
 *
 * Call `findTransferAccountErrors` first — rows whose counterpart doesn't
 * resolve arrive here with `transferAccountId` null, which would import them as
 * ordinary transactions.
 */
export function buildImportPreview(dbi: DB, accountId: number, rows: ParsedImportRow[]): ImportPreviewRow[] {
  const categoryIdByName = new Map<string, number>();
  const categoryNameById = new Map<number, string>();
  for (const c of dbi
    .select({ id: schema.categories.id, name: schema.categories.name })
    .from(schema.categories)
    .where(eq(schema.categories.hidden, false))
    .all()) {
    if (!categoryIdByName.has(c.name.toLowerCase())) categoryIdByName.set(c.name.toLowerCase(), c.id);
    categoryNameById.set(c.id, c.name);
  }

  const existing = dbi
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      payee: schema.transactions.payee,
      importHash: schema.transactions.importHash,
    })
    .from(schema.transactions)
    .where(eq(schema.transactions.accountId, accountId))
    .all();
  const existingHashes = new Set(existing.map((t) => t.importHash).filter((h): h is string => h != null));
  const existingTriples = new Set(existing.map((t) => `${t.date}|${t.amount}|${t.payee}`));
  const seenInBatch = new Set<string>();

  // Candidates for an amount revision, grouped by the part that must match
  // exactly. Rows are dropped from their group once claimed, so two CSV rows
  // can't both revise the same transaction.
  const candidatesByDatePayee = new Map<string, RevisionCandidate[]>();
  for (const t of existing) {
    const key = `${t.date}|${t.payee}`;
    const group = candidatesByDatePayee.get(key);
    if (group) group.push({ id: t.id, amount: t.amount });
    else candidatesByDatePayee.set(key, [{ id: t.id, amount: t.amount }]);
  }

  const accountsById = new Map(
    dbi
      .select({ id: schema.accounts.id, name: schema.accounts.name })
      .from(schema.accounts)
      .all()
      .map((a) => [a.id, a.name] as const)
  );
  const accountIdByName = new Map([...accountsById].map(([id, name]) => [name.toLowerCase(), id] as const));

  return rows.map((row): ImportPreviewRow => {
    const resolved = resolveCategoryName(row.categoryName);
    const categoryId = resolved.isReadyToAssign
      ? null
      : resolved.name != null
        ? (categoryIdByName.get(resolved.name.toLowerCase()) ?? null)
        : null;
    const transferAccountId =
      row.transferAccountName != null
        ? (accountIdByName.get(row.transferAccountName.toLowerCase()) ?? null)
        : null;
    const payee = transferPayee(row);
    const memo = transferMemo(row);
    const importHash = computeImportHash(accountId, row.date, row.amount, payee);
    const triple = `${row.date}|${row.amount}|${payee}`;
    const isDuplicate = existingHashes.has(importHash) || existingTriples.has(triple) || seenInBatch.has(triple);
    seenInBatch.add(triple);

    const key = `${row.date}|${payee}`;
    const group = candidatesByDatePayee.get(key) ?? [];
    let status: ImportPreviewRow["status"] = isDuplicate ? "duplicate" : "new";
    let revision: RevisionCandidate | null = null;
    if (isDuplicate) {
      // Spend the transaction this row already matches, so a later row in the
      // same file can't "revise" (and overwrite) it.
      const claimed = group.findIndex((c) => c.amount === row.amount);
      if (claimed !== -1) candidatesByDatePayee.set(key, group.toSpliced(claimed, 1));
    } else {
      revision = findRevisionTarget(group, row.amount);
      if (revision != null) {
        status = "revised";
        candidatesByDatePayee.set(
          key,
          group.filter((c) => c.id !== revision!.id)
        );
      }
    }

    const categoryName = categoryId != null ? categoryNameById.get(categoryId)! : resolved.name;

    return {
      line: row.line,
      date: row.date,
      payee,
      memo,
      amount: row.amount,
      categoryId,
      categoryName,
      status,
      existingId: revision?.id ?? null,
      existingAmount: revision?.amount ?? null,
      importHash,
      transferAccountId,
      transferAccountName: transferAccountId != null ? (accountsById.get(transferAccountId) ?? null) : null,
    };
  });
}

export interface ImportInsertRow {
  date: string;
  payee: string;
  memo: string;
  amount: number;
  categoryId: number | null;
  importHash: string;
  /** Counterpart account: when set, the row commits as a paired transfer instead of a plain transaction. */
  transferAccountId?: number | null;
}

/** An existing transaction whose amount the bank restated after the export. */
export interface ImportRevisionRow {
  id: number;
  amount: number;
  importHash: string;
}

/**
 * Insert the checked import rows (uncategorized unless matched), stamping
 * import_hash. Idempotent per `batchId` (minted once by `previewImportAction`
 * and carried through the confirm form): if this batch was already
 * committed — e.g. a retried/resubmitted server action after the client
 * never saw the response — this is a silent no-op that returns the row
 * count from the original commit instead of inserting everything again.
 * This is deliberately not a UNIQUE constraint on import content: two
 * legitimately identical transactions (same date/payee/amount) are real
 * data and must stay importable when the user checks them both.
 *
 * Rows carrying a `transferAccountId` become transfers: both legs are written
 * and linked by `transferPairId`, matching `createTransfer`, so the counterpart
 * account moves too. Only the imported leg gets the `import_hash` — the hash is
 * keyed to this account, date, amount and payee, and the mirrored leg has the
 * opposite amount. The returned count is the number of CSV rows, not of
 * inserted transactions.
 *
 * `revisions` are rows the preview matched to an existing transaction at a
 * slightly different amount: those update in place instead of inserting, and
 * count toward the return value like any other row.
 */
export function commitImport(
  dbi: DB,
  accountId: number,
  rows: ImportInsertRow[],
  batchId: string,
  revisions: ImportRevisionRow[] = []
): number {
  return dbi.transaction((tx) => {
    const existing = tx
      .select({ count: schema.importBatches.count })
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, batchId))
      .get();
    if (existing) return existing.count;

    if (rows.length > 0) {
      const typeById = new Map(
        tx
          .select({ id: schema.accounts.id, type: schema.accounts.type })
          .from(schema.accounts)
          .all()
          .map((a) => [a.id, a.type] as const)
      );
      const values = rows.flatMap((r): (typeof schema.transactions.$inferInsert)[] => {
        const leg = {
          accountId,
          date: r.date,
          payee: r.payee,
          categoryId: r.categoryId,
          memo: r.memo,
          amount: r.amount,
          cleared: true,
          importHash: r.importHash,
        };
        if (r.transferAccountId == null) return [leg];

        // Same rule as createTransfer: a category only applies to the on-budget
        // leg of a transfer that touches a tracking account.
        const thisIsTracking = typeById.get(accountId) === "tracking";
        const otherIsTracking = typeById.get(r.transferAccountId) === "tracking";
        const transferPairId = crypto.randomUUID();
        return [
          {
            ...leg,
            categoryId: !thisIsTracking && otherIsTracking ? r.categoryId : null,
            transferAccountId: r.transferAccountId,
            transferPairId,
          },
          {
            accountId: r.transferAccountId,
            date: r.date,
            payee: r.payee,
            categoryId: !otherIsTracking && thisIsTracking ? r.categoryId : null,
            memo: r.memo,
            amount: -r.amount,
            cleared: true,
            importHash: null,
            transferAccountId: accountId,
            transferPairId,
          },
        ];
      });
      tx.insert(schema.transactions).values(values).run();
    }

    for (const r of revisions) {
      const target = tx
        .select({ transferPairId: schema.transactions.transferPairId })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, r.id))
        .get();
      if (!target) continue; // deleted between preview and confirm

      tx.update(schema.transactions)
        .set({ amount: r.amount, importHash: r.importHash })
        .where(eq(schema.transactions.id, r.id))
        .run();

      // A transfer's two legs must stay mirrored, or both accounts drift.
      if (target.transferPairId != null) {
        tx.update(schema.transactions)
          .set({ amount: -r.amount })
          .where(
            and(
              eq(schema.transactions.transferPairId, target.transferPairId),
              ne(schema.transactions.id, r.id)
            )
          )
          .run();
      }
    }

    const count = rows.length + revisions.length;
    tx.insert(schema.importBatches)
      .values({ id: batchId, accountId, count, committedAt: new Date().toISOString() })
      .run();

    return count;
  });
}

/**
 * Investments (tracking-account holdings + Yahoo Finance price cache).
 *
 * Prices are cached by symbol (shared across accounts) and always stored
 * already converted into the budget's currency — see `db/schema.ts` for why.
 * `refreshHoldingPrices` is the only function in the app that ends up
 * calling the network (via `./prices`), and only ever runs from the
 * "Refresh prices" server action.
 */

export interface HoldingInput {
  symbol: string;
  name: string;
  quantity: number;
}

export function createHolding(dbi: DB, accountId: number, input: HoldingInput): number {
  const result = dbi
    .insert(schema.holdings)
    .values({ accountId, symbol: input.symbol, name: input.name, quantity: input.quantity })
    .run();
  return Number(result.lastInsertRowid);
}

export function updateHolding(dbi: DB, id: number, input: HoldingInput): void {
  dbi
    .update(schema.holdings)
    .set({ symbol: input.symbol, name: input.name, quantity: input.quantity })
    .where(eq(schema.holdings.id, id))
    .run();
}

export function deleteHolding(dbi: DB, id: number): void {
  dbi.delete(schema.holdings).where(eq(schema.holdings.id, id)).run();
}

export interface HoldingRow {
  id: number;
  symbol: string;
  name: string;
  quantity: number;
  /** Latest cached price in the budget currency's minor units, null if never fetched. */
  priceRappen: number | null;
  /** quantity * priceRappen, rounded; null if priceRappen is null. */
  valueRappen: number | null;
  /** Native quote currency, e.g. "USD"; null until first fetch. */
  currency: string | null;
  /** Native -> budget rate applied, null if same currency or unconverted. */
  fxRate: number | null;
  fetchedAt: string | null;
  fetchError: string | null;
  stale: boolean;
}

export interface HoldingsView {
  budgetCurrency: string;
  holdings: HoldingRow[];
  totalValueRappen: number;
  /** False if any holding has never been priced — sync-balance stays disabled. */
  hasAllPrices: boolean;
  oldestFetchedAt: string | null;
  /** True if any held symbol is missing a price or stale (>24h) — triggers an on-view auto refresh. */
  needsRefresh: boolean;
  accountBalance: number;
}

/** Everything the account page's Holdings section renders. */
export function getHoldingsView(accountId: number, dbi: DB = db): HoldingsView {
  const holdingRows = dbi
    .select()
    .from(schema.holdings)
    .where(eq(schema.holdings.accountId, accountId))
    .orderBy(schema.holdings.symbol)
    .all();

  const symbols = [...new Set(holdingRows.map((h) => h.symbol))];
  const priceRows = symbols.length
    ? dbi.select().from(schema.prices).where(inArray(schema.prices.symbol, symbols)).all()
    : [];
  const priceBySymbol = new Map(priceRows.map((p) => [p.symbol, p]));

  let totalValueRappen = 0;
  let hasAllPrices = true;
  let oldestFetchedAt: string | null = null;
  let needsRefresh = false;

  const holdings: HoldingRow[] = holdingRows.map((h) => {
    const p = priceBySymbol.get(h.symbol);
    const priceRappen = p?.priceRappen ?? null;
    const valueRappen = priceRappen != null ? Math.round(h.quantity * priceRappen) : null;
    if (priceRappen == null) hasAllPrices = false;
    if (valueRappen != null) totalValueRappen += valueRappen;
    if (p?.fetchedAt && (oldestFetchedAt == null || p.fetchedAt < oldestFetchedAt)) {
      oldestFetchedAt = p.fetchedAt;
    }
    const stale = isStale(p?.fetchedAt ?? null);
    if (stale || p?.fetchError) needsRefresh = true;
    return {
      id: h.id,
      symbol: h.symbol,
      name: h.name,
      quantity: h.quantity,
      priceRappen,
      valueRappen,
      currency: p?.currency ?? null,
      fxRate: p?.fxRate ?? null,
      fetchedAt: p?.fetchedAt ?? null,
      fetchError: p?.fetchError ?? null,
      stale,
    };
  });

  return {
    budgetCurrency: getCurrency(dbi),
    holdings,
    totalValueRappen,
    hasAllPrices,
    oldestFetchedAt,
    needsRefresh,
    accountBalance: getAccountDetail(accountId, dbi)?.balance ?? 0,
  };
}

export interface PriceRefreshResult {
  updated: string[];
  failed: { symbol: string; error: string }[];
}

/**
 * Fetch fresh quotes for every symbol held by `accountId`, converting into
 * the budget currency via a live FX quote when needed. A failed symbol
 * keeps its last cached price/fetchedAt and records the error instead —
 * never throws, never blocks the other symbols.
 */
export async function refreshHoldingPrices(dbi: DB, accountId: number): Promise<PriceRefreshResult> {
  const symbols = [
    ...new Set(
      dbi
        .select({ symbol: schema.holdings.symbol })
        .from(schema.holdings)
        .where(eq(schema.holdings.accountId, accountId))
        .all()
        .map((h) => h.symbol)
    ),
  ];

  const budgetCurrency = getCurrency(dbi);
  const fxRateByCurrency = new Map<string, number | null>();
  const updated: string[] = [];
  const failed: { symbol: string; error: string }[] = [];

  function markFailed(symbol: string, error: string): void {
    failed.push({ symbol, error });
    const existing = dbi.select().from(schema.prices).where(eq(schema.prices.symbol, symbol)).get();
    if (existing) {
      dbi.update(schema.prices).set({ fetchError: error }).where(eq(schema.prices.symbol, symbol)).run();
    }
    // No existing row: leave unset — the UI just shows "not fetched yet" rather
    // than a persisted error for a symbol that's never had a valid price.
  }

  for (const symbol of symbols) {
    const quote = await fetchYahooQuote(symbol);
    if (!quote.ok) {
      markFailed(symbol, quote.error);
      continue;
    }

    let fxRate: number | null = null;
    if (quote.quote.currency !== budgetCurrency) {
      if (!fxRateByCurrency.has(quote.quote.currency)) {
        const fx = await fetchYahooQuote(fxSymbol(quote.quote.currency, budgetCurrency));
        fxRateByCurrency.set(quote.quote.currency, fx.ok ? fx.quote.price : null);
      }
      fxRate = fxRateByCurrency.get(quote.quote.currency) ?? null;
      if (fxRate == null) {
        markFailed(symbol, `FX rate ${quote.quote.currency}→${budgetCurrency} unavailable`);
        continue;
      }
    }

    const priceRappen = toBudgetMinorUnits(quote.quote.price, fxRate);
    const fetchedAt = new Date().toISOString();
    const existing = dbi.select().from(schema.prices).where(eq(schema.prices.symbol, symbol)).get();
    const values = { priceRappen, currency: quote.quote.currency, fxRate, fetchedAt, fetchError: null };
    if (existing) {
      dbi.update(schema.prices).set(values).where(eq(schema.prices.symbol, symbol)).run();
    } else {
      dbi.insert(schema.prices).values({ symbol, ...values }).run();
    }
    updated.push(symbol);
  }

  return { updated, failed };
}

/** Signed amount to book so the account balance becomes `portfolioValueRappen`; null if already equal. */
export function computeSyncDelta(accountBalanceRappen: number, portfolioValueRappen: number): number | null {
  const delta = portfolioValueRappen - accountBalanceRappen;
  return delta === 0 ? null : delta;
}

export type SyncBalanceResult = { ok: true; delta: number } | { ok: false; error: string };

/** Book an uncategorized "Balance Adjustment" transaction so the account balance matches total holdings value. */
export function syncHoldingsBalance(dbi: DB, accountId: number): SyncBalanceResult {
  const view = getHoldingsView(accountId, dbi);
  if (view.holdings.length === 0) return { ok: false, error: "No holdings to sync." };
  if (!view.hasAllPrices) return { ok: false, error: "Fetch prices before syncing." };

  const delta = computeSyncDelta(view.accountBalance, view.totalValueRappen);
  if (delta == null) return { ok: false, error: "Already in sync." };

  createTransaction(dbi, {
    accountId,
    date: new Date().toISOString().slice(0, 10),
    payee: BALANCE_ADJUSTMENT_PAYEE,
    categoryId: null,
    memo: "Synced to holdings value",
    amount: delta,
    cleared: true,
  });

  return { ok: true, delta };
}

export type SetBalanceResult = { ok: true; delta: number } | { ok: false; error: string };

/**
 * Book an uncategorized "Balance Adjustment" transaction so the account
 * balance matches a user-typed target — the manual counterpart to
 * `syncHoldingsBalance` for tracking accounts whose funds aren't
 * exchange-listed (e.g. a pillar-3a account), where the user reads the
 * current value off the provider's app instead of it being priced here.
 */
export function setAccountBalance(dbi: DB, accountId: number, targetRappen: number): SetBalanceResult {
  const detail = getAccountDetail(accountId, dbi);
  if (!detail) return { ok: false, error: "Account not found." };

  const delta = computeSyncDelta(detail.balance, targetRappen);
  if (delta == null) return { ok: false, error: "Already at that balance." };

  createTransaction(dbi, {
    accountId,
    date: new Date().toISOString().slice(0, 10),
    payee: BALANCE_ADJUSTMENT_PAYEE,
    categoryId: null,
    memo: "Manual balance update",
    amount: delta,
    cleared: true,
  });

  return { ok: true, delta };
}

/**
 * Swissquote statement import (see `swissquote-import.ts` for text
 * extraction/parsing). "Boundary" rows (Anfangsbestand/Schlussbilanz) and
 * "other" rows (FX conversions between the account's currency
 * sub-ledgers — internal shuffling, not a real cash flow) are excluded from
 * the preview entirely; they only mattered for the parser's internal
 * balance check.
 */

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A deposit ("Zahlung von") counts as already recorded if any transaction in this account has the same amount within ±3 days. */
function matchExistingDeposit(dbi: DB, accountId: number, date: string, amount: number): boolean {
  const match = dbi
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.accountId, accountId),
        eq(schema.transactions.amount, amount),
        gte(schema.transactions.date, addDaysIso(date, -3)),
        lte(schema.transactions.date, addDaysIso(date, 3))
      )
    )
    .get();
  return match != null;
}

export interface SwissquotePreviewRow {
  /** Groups rows for commit-time whole-statement idempotency — see `commitSwissquoteImport`. */
  statementKey: string;
  key: string;
  date: string;
  kind: Exclude<StatementEntry["kind"], "other" | "boundary">;
  rawType: string;
  currency: string;
  /** Signed minor units in the row's own (statement section) currency. */
  amount: number;
  ticker?: string;
  yahooSymbol?: string;
  name?: string;
  /** Buy/sell share count. */
  quantity?: number;
  /** Buy/sell only: holding quantity after applying this row (and every earlier row for the same symbol in this preview batch). */
  resultingQuantity?: number;
  /** False for a dividend/interest/fee/deposit in a currency other than the budget's — shown info-only, never applied. */
  bookable: boolean;
  payee?: string;
  /** Already applied in an earlier commit (this or an overlapping statement) — unchecked by default. */
  isDuplicate: boolean;
  /** Deposit only: an existing transaction already covers this amount within ±3 days — unchecked by default. */
  exists: boolean;
  importHash: string;
}

export interface SwissquoteStatementSummary {
  statementKey: string;
  periodStart: string;
  periodEnd: string;
}

export interface SwissquotePreview {
  rows: SwissquotePreviewRow[];
  statements: SwissquoteStatementSummary[];
}

function swissquoteStatementKey(accountId: number, statement: ParsedStatement): string {
  return `sq:${accountId}:${statement.periodStart}:${statement.periodEnd}`;
}

function swissquotePayee(entry: StatementEntry): string {
  if (entry.kind === "dividend") return `Dividend: ${entry.ticker ?? "?"}`;
  if (entry.kind === "interest") return "Interest";
  if (entry.kind === "fee") return "Swissquote fees";
  return "Deposit";
}

/**
 * Build the combined preview for one or more parsed statements (processed
 * in period order, as required when several PDFs are uploaded together).
 * Never writes to the DB.
 */
export function buildSwissquotePreview(dbi: DB, accountId: number, statements: ParsedStatement[]): SwissquotePreview {
  const budgetCurrency = getCurrency(dbi);

  const qtyBySymbol = new Map(
    dbi
      .select({ symbol: schema.holdings.symbol, quantity: schema.holdings.quantity })
      .from(schema.holdings)
      .where(eq(schema.holdings.accountId, accountId))
      .all()
      .map((h) => [h.symbol, h.quantity])
  );

  const existingHashes = new Set(
    dbi
      .select({ importHash: schema.importedStatementRows.importHash })
      .from(schema.importedStatementRows)
      .where(eq(schema.importedStatementRows.accountId, accountId))
      .all()
      .map((r) => r.importHash)
  );
  const seenInBatch = new Set<string>();

  const sorted = [...statements].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  const rows: SwissquotePreviewRow[] = [];
  const summaries: SwissquoteStatementSummary[] = [];
  let rowSeq = 0;

  for (const statement of sorted) {
    const statementKey = swissquoteStatementKey(accountId, statement);
    summaries.push({ statementKey, periodStart: statement.periodStart, periodEnd: statement.periodEnd });

    for (const section of statement.sections) {
      for (const entry of section.entries) {
        if (entry.kind === "boundary" || entry.kind === "other") continue;

        const importHash = computeSwissquoteImportHash(accountId, entry);
        const isDuplicate = existingHashes.has(importHash) || seenInBatch.has(importHash);
        seenInBatch.add(importHash);
        const key = `r${rowSeq++}`;

        if (entry.kind === "buy" || entry.kind === "sell") {
          // Parser guarantees ticker+quantity on every buy/sell row — see swissquote-import.ts.
          const symbol = entry.yahooSymbol!;
          const current = qtyBySymbol.get(symbol) ?? 0;
          const resultingQuantity = entry.kind === "buy" ? current + entry.quantity! : current - entry.quantity!;
          qtyBySymbol.set(symbol, resultingQuantity);
          rows.push({
            statementKey,
            key,
            date: entry.date,
            kind: entry.kind,
            rawType: entry.rawType,
            currency: entry.currency,
            amount: entry.amount,
            ticker: entry.ticker,
            yahooSymbol: symbol,
            name: entry.name,
            quantity: entry.quantity,
            resultingQuantity,
            bookable: true,
            isDuplicate,
            exists: false,
            importHash,
          });
          continue;
        }

        const bookable = entry.currency === budgetCurrency;
        const exists = entry.kind === "deposit" && bookable ? matchExistingDeposit(dbi, accountId, entry.date, entry.amount) : false;

        rows.push({
          statementKey,
          key,
          date: entry.date,
          kind: entry.kind,
          rawType: entry.rawType,
          currency: entry.currency,
          amount: entry.amount,
          ticker: entry.ticker,
          name: entry.name,
          bookable,
          payee: swissquotePayee(entry),
          isDuplicate,
          exists,
          importHash,
        });
      }
    }
  }

  return { rows, statements: summaries };
}

export interface SwissquoteRowInput {
  statementKey: string;
  kind: Exclude<StatementEntry["kind"], "other" | "boundary">;
  date: string;
  /** Signed minor units; used for the transaction kinds (dividend/interest/fee/deposit). */
  amount: number;
  quantity?: number;
  yahooSymbol?: string;
  name?: string;
  payee?: string;
  importHash: string;
}

/**
 * Apply the checked preview rows: buy/sell update (or create) the holding's
 * quantity, everything else books an uncategorized transaction (tracking
 * accounts don't budget). One DB transaction.
 *
 * Idempotent at two levels: whole-statement (grouped by `statementKey`,
 * deterministically `sq:<account>:<periodStart>:<periodEnd>` — reuses
 * `import_batches`, same ledger and pattern as the CSV importer's
 * `commitImport`) and per-row (`imported_statement_rows`, keyed by the
 * bank's reference number) so a statement whose period overlaps an earlier
 * import doesn't double-apply the rows they share.
 */
export function commitSwissquoteImport(dbi: DB, accountId: number, rows: SwissquoteRowInput[]): number {
  return dbi.transaction((tx) => {
    const byStatement = new Map<string, SwissquoteRowInput[]>();
    for (const row of rows) {
      const group = byStatement.get(row.statementKey);
      if (group) group.push(row);
      else byStatement.set(row.statementKey, [row]);
    }

    const now = new Date().toISOString();
    let committed = 0;

    for (const [statementKey, statementRows] of byStatement) {
      const alreadyCommitted = tx
        .select({ count: schema.importBatches.count })
        .from(schema.importBatches)
        .where(eq(schema.importBatches.id, statementKey))
        .get();
      if (alreadyCommitted) continue; // whole statement already imported — hard no-op

      for (const row of statementRows) {
        if (row.kind === "buy" || row.kind === "sell") {
          if (!row.yahooSymbol || row.quantity == null) continue;
          const delta = row.kind === "buy" ? row.quantity : -row.quantity;
          const existing = tx
            .select()
            .from(schema.holdings)
            .where(and(eq(schema.holdings.accountId, accountId), eq(schema.holdings.symbol, row.yahooSymbol)))
            .get();
          if (existing) {
            tx.update(schema.holdings)
              .set({ quantity: existing.quantity + delta })
              .where(eq(schema.holdings.id, existing.id))
              .run();
          } else {
            tx.insert(schema.holdings)
              .values({ accountId, symbol: row.yahooSymbol, name: row.name ?? "", quantity: delta })
              .run();
          }
        } else {
          tx.insert(schema.transactions)
            .values({
              accountId,
              date: row.date,
              payee: row.payee ?? "",
              categoryId: null,
              memo: "",
              amount: row.amount,
              cleared: true,
              importHash: row.importHash,
            })
            .run();
        }

        tx.insert(schema.importedStatementRows).values({ accountId, importHash: row.importHash, committedAt: now }).run();
        committed++;
      }

      tx.insert(schema.importBatches)
        .values({ id: statementKey, accountId, count: statementRows.length, committedAt: now })
        .run();
    }

    return committed;
  });
}

/**
 * Category spending stats (the `/stats` page). Aggregates raw transactions by
 * `category_id` over a period — deliberately simpler than budget "activity":
 * it answers "what did I spend on X" from the ledger directly and does NOT
 * apply credit-card payment-category mechanics. Tracking accounts are excluded
 * to match budget math (their movements aren't spending). Outflow/inflow are
 * both reported as positive minor units; `net` is outflow − inflow (net spend).
 */

export type { StatsPeriod };

/**
 * Synthetic, app-generated payees booked as uncategorized (categoryId null)
 * bookkeeping transactions: account seeding and holdings/balance
 * reconciliation, not real income. Stats must exclude them when treating
 * null-category inflows as income.
 */
export const STARTING_BALANCE_PAYEE = "Starting Balance";
export const BALANCE_ADJUSTMENT_PAYEE = "Balance Adjustment";

export interface StatsBucket {
  /** "YYYY-MM" for month buckets, or the payee string for this-month buckets. */
  key: string;
  label: string;
  outflow: number;
  inflow: number;
  count: number;
}

export interface CategoryStats {
  period: StatsPeriod;
  totalOutflow: number;
  totalInflow: number;
  /** outflow − inflow: net amount spent over the period. */
  net: number;
  count: number;
  /** Elapsed months in the period (for the per-month average). 0 when empty. */
  monthsElapsed: number;
  avgOutflowPerMonth: number;
  /**
   * Per-month for year/all-time. For this-month: per-payee for a single
   * category, per-category when aggregating all categories. Top 12 for the
   * non-month kinds.
   */
  buckets: StatsBucket[];
  bucketKind: "month" | "payee" | "category";
  currency: string;
}

/**
 * `categoryId = null` aggregates across ALL categories. In that mode
 * transactions with a null `category_id` are excluded — those are transfers
 * (and any uncategorized rows), which aren't spending — so the all-categories
 * total equals the sum of the per-category totals and stays consistent with
 * the single-category view.
 *
 * All-categories mode ALSO excludes transfer legs (`transferAccountId IS NOT
 * NULL`), even when categorized — e.g. a "Transfer to Brokerage" row filed
 * under Saving/Investing. Without this, the Categories tab's total would
 * double-count money that's just moving between accounts, disagreeing with
 * Overview's spending total. Specific-category mode deliberately stays
 * inclusive of transfer legs: it's a ledger view of that one category (every
 * row filed under it, transfer or not), not an aggregate that has to
 * reconcile with anything else.
 */
export function getCategoryStats(
  categoryId: number | null,
  period: StatsPeriod,
  dbi: DB = db,
  now: Date = new Date()
): CategoryStats {
  const { start, end } = statsPeriodBounds(period);
  const mode = periodMode(period);
  const bucketKind: "month" | "payee" | "category" =
    mode !== "month" ? "month" : categoryId == null ? "category" : "payee";

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

  const groupExpr =
    bucketKind === "month"
      ? sql<string>`substr(${schema.transactions.date}, 1, 7)`
      : bucketKind === "category"
        ? sql<string>`cast(${schema.transactions.categoryId} as text)`
        : sql<string>`${schema.transactions.payee}`;

  const rows = dbi
    .select({
      key: groupExpr,
      outflow: sql<number>`coalesce(sum(case when ${schema.transactions.amount} < 0 then -${schema.transactions.amount} else 0 end), 0)`,
      inflow: sql<number>`coalesce(sum(case when ${schema.transactions.amount} > 0 then ${schema.transactions.amount} else 0 end), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(schema.transactions)
    .innerJoin(schema.accounts, eq(schema.transactions.accountId, schema.accounts.id))
    .where(and(...conditions))
    .groupBy(groupExpr)
    .all();

  let totalOutflow = 0;
  let totalInflow = 0;
  let count = 0;
  for (const r of rows) {
    totalOutflow += r.outflow;
    totalInflow += r.inflow;
    count += r.count;
  }

  let buckets: StatsBucket[];
  if (bucketKind === "month") {
    buckets = rows
      .map((r) => ({
        key: r.key,
        label: monthShortLabel(r.key),
        outflow: r.outflow,
        inflow: r.inflow,
        count: r.count,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  } else {
    // This-month view: biggest spenders first. Payee keys are raw strings;
    // category keys are ids resolved to names here.
    const categoryNames =
      bucketKind === "category"
        ? new Map(
            dbi
              .select({ id: schema.categories.id, name: schema.categories.name })
              .from(schema.categories)
              .all()
              .map((c) => [String(c.id), c.name] as const)
          )
        : null;
    const labelFor = (key: string): string =>
      bucketKind === "category"
        ? (categoryNames?.get(key) ?? "(unknown)")
        : key.trim() === ""
          ? "(no payee)"
          : key;
    buckets = rows
      .map((r) => ({
        key: r.key,
        label: labelFor(r.key),
        outflow: r.outflow,
        inflow: r.inflow,
        count: r.count,
      }))
      .sort((a, b) => b.outflow - a.outflow || b.inflow - a.inflow)
      .slice(0, 12);
  }

  // Elapsed months for the average. For year and all-time, span from the
  // category's first active month within the period through the LAST month
  // of the period, capped at the current month — so a past year averages
  // over its own 12 months (not through today), while the current year/all
  // time still stops at now. `buckets` is the per-month aggregation sorted
  // ascending here, so buckets[0].key is that first active month.
  const nowKey = monthKeyOf(now);
  let monthsElapsed: number;
  if (count === 0) {
    monthsElapsed = 0;
  } else if (mode === "month") {
    monthsElapsed = 1;
  } else {
    const periodEndKey = mode === "year" ? `${period}-12` : nowKey;
    const cappedEndKey = periodEndKey < nowKey ? periodEndKey : nowKey;
    monthsElapsed = monthSpan(buckets[0].key, cappedEndKey);
  }

  return {
    period,
    totalOutflow,
    totalInflow,
    net: totalOutflow - totalInflow,
    count,
    monthsElapsed,
    avgOutflowPerMonth: monthsElapsed > 0 ? Math.round(totalOutflow / monthsElapsed) : 0,
    buckets,
    bucketKind,
    currency: getCurrency(dbi),
  };
}

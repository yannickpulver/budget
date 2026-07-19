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
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
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
} from "./budget-math";
import { computeImportHash, resolveCategoryName, type ParsedImportRow } from "./csv-import";
import { formatMoney } from "./currency";
import { fetchYahooQuote, fxSymbol, isStale, toBudgetMinorUnits } from "./prices";
import { computeSwissquoteImportHash, type ParsedStatement, type StatementEntry } from "./swissquote-import";
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
const MONTH_RE = /^\d{4}-\d{2}$/;

export interface BudgetData {
  accounts: Map<number, AccountInfo>;
  /** Account id -> name, for display-only uses (e.g. "Payment: <account>" activity labels). */
  accountNames: Map<number, string>;
  groups: GroupMeta[];
  categories: CategoryMeta[];
  categoryIds: number[];
  assignmentsByMonth: Map<string, Map<number, number>>;
  txnsByMonth: Map<string, ActivityTxnInput[]>;
  earliestMonth: string | null;
  currency: string;
  rtaAdjustment: RtaAdjustment | null;
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
    })
    .from(schema.categories)
    .all();

  const assignmentsByMonth = new Map<string, Map<number, number>>();
  for (const row of dbi.select().from(schema.assignments).all()) {
    let monthMap = assignmentsByMonth.get(row.month);
    if (!monthMap) {
      monthMap = new Map();
      assignmentsByMonth.set(row.month, monthMap);
    }
    monthMap.set(row.categoryId, row.amount);
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
    txnsByMonth,
    earliestMonth,
    currency: getSetting("currency") ?? DEFAULT_CURRENCY,
    rtaAdjustment: parseRtaAdjustment(
      getSetting(SETTING_RTA_ADJUSTMENT),
      getSetting(SETTING_RTA_ADJUSTMENT_MONTH)
    ),
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
  goal: GoalStatus | null;
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
          const goal = computeGoalStatus(category.monthlyTarget, cell.assigned);
          if (goal && !goal.met) totalUnderfunded += goal.remaining;
          const activityTransactions = [...(activityEntriesByCategory.get(category.id) ?? [])].sort(
            (a, b) => a.date.localeCompare(b.date) || a.id - b.id
          );
          return {
            id: category.id,
            name: category.name,
            assigned: cell.assigned,
            activity: cell.activity,
            available: cell.available,
            monthlyTarget: category.monthlyTarget,
            goal,
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
    readyToAssign: snapshot.readyToAssign,
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
      return category.goal != null && !category.goal.met;
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
  opts: { search?: string; page?: number } = {},
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

  const filtered = search === "" ? rows : rows.filter((r) => registerRowMatches(r, search));
  const start = (page - 1) * REGISTER_PAGE_SIZE;

  return {
    rows: filtered.slice(start, start + REGISTER_PAGE_SIZE),
    total: filtered.length,
    page,
    pageSize: REGISTER_PAGE_SIZE,
  };
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
    .select({ paymentCategoryId: schema.accounts.paymentCategoryId })
    .from(schema.accounts)
    .all()) {
    if (row.paymentCategoryId != null) referencedIds.add(row.paymentCategoryId);
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
  const payment = dbi
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.paymentCategoryId, id))
    .limit(1)
    .all();
  return payment.length > 0;
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

/**
 * Create an account and, if non-zero, a "Starting Balance" transaction.
 * Uncategorized (categoryId null) for every account type — for on-budget
 * accounts that lands in Ready to Assign; tracking accounts aren't budgeted
 * so it's simply uncategorized. Also seeds the starter category set the
 * first time ever an account is created against an empty categories table.
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
        payee: "Starting Balance",
        categoryId: null,
        memo: "",
        amount: input.startingBalance,
        cleared: true,
      })
      .run();
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
 */
export function setAccountType(dbi: DB, id: number, type: AccountType): void {
  dbi.update(schema.accounts).set({ type }).where(eq(schema.accounts.id, id)).run();
}

/** Sets or clears (`null`) the emoji override shown instead of the type's default icon. */
export function setAccountIcon(dbi: DB, id: number, icon: string | null): void {
  dbi.update(schema.accounts).set({ icon }).where(eq(schema.accounts.id, id)).run();
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
  isDuplicate: boolean;
  importHash: string;
}

/**
 * Build the import preview: match categories by name (case-insensitive,
 * first match wins), flag duplicates against existing transactions in this
 * account (by import_hash or by date+amount+payee) and against earlier rows
 * in the same file.
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

  return rows.map((row): ImportPreviewRow => {
    const resolved = resolveCategoryName(row.categoryName);
    const categoryId = resolved.isReadyToAssign
      ? null
      : resolved.name != null
        ? (categoryIdByName.get(resolved.name.toLowerCase()) ?? null)
        : null;
    const importHash = computeImportHash(accountId, row.date, row.amount, row.payee);
    const triple = `${row.date}|${row.amount}|${row.payee}`;
    const isDuplicate = existingHashes.has(importHash) || existingTriples.has(triple) || seenInBatch.has(triple);
    seenInBatch.add(triple);

    const categoryName = categoryId != null ? categoryNameById.get(categoryId)! : resolved.name;

    return {
      line: row.line,
      date: row.date,
      payee: row.payee,
      memo: row.memo,
      amount: row.amount,
      categoryId,
      categoryName,
      isDuplicate,
      importHash,
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
 */
export function commitImport(dbi: DB, accountId: number, rows: ImportInsertRow[], batchId: string): number {
  return dbi.transaction((tx) => {
    const existing = tx
      .select({ count: schema.importBatches.count })
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, batchId))
      .get();
    if (existing) return existing.count;

    if (rows.length > 0) {
      tx.insert(schema.transactions)
        .values(
          rows.map((r) => ({
            accountId,
            date: r.date,
            payee: r.payee,
            categoryId: r.categoryId,
            memo: r.memo,
            amount: r.amount,
            cleared: true,
            importHash: r.importHash,
          }))
        )
        .run();
    }

    tx.insert(schema.importBatches)
      .values({ id: batchId, accountId, count: rows.length, committedAt: new Date().toISOString() })
      .run();

    return rows.length;
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
    payee: "Balance Adjustment",
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
    payee: "Balance Adjustment",
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

/**
 * Server-side budget query layer.
 *
 * Computes YNAB month snapshots with budget-math's compute-and-carry design and
 * caches them so a request never rewalks the full history. Every month snapshot
 * is memoized; the walk continues from the furthest month already computed.
 * Any write to transactions/assignments/categories must call
 * `invalidateBudgetCache()` to drop the cache.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  computeGoalStatus,
  computeMonthSnapshot,
  monthKey,
  nextMonthKey,
  type AccountInfo,
  type AccountType,
  type GoalStatus,
  type MonthSnapshot,
  type TxnInput,
} from "./budget-math";
import { computeImportHash, resolveCategoryName, type ParsedImportRow } from "./csv-import";
import { formatMoney } from "./currency";
import { fetchYahooQuote, fxSymbol, isStale, toBudgetMinorUnits } from "./prices";
import { db } from "@/db";
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

export interface BudgetData {
  accounts: Map<number, AccountInfo>;
  groups: GroupMeta[];
  categories: CategoryMeta[];
  categoryIds: number[];
  assignmentsByMonth: Map<string, Map<number, number>>;
  txnsByMonth: Map<string, TxnInput[]>;
  earliestMonth: string | null;
  currency: string;
}

/** Read the whole budget into memory (one pass per cache lifetime). */
export function loadBudgetData(dbi: DB): BudgetData {
  const accountRows = dbi
    .select({
      id: schema.accounts.id,
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

  const txnsByMonth = new Map<string, TxnInput[]>();
  let earliestMonth: string | null = null;
  const txnRows = dbi
    .select({
      date: schema.transactions.date,
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
      accountId: row.accountId,
      categoryId: row.categoryId ?? null,
      amount: row.amount,
      transferAccountId: row.transferAccountId ?? null,
    });
  }

  for (const month of assignmentsByMonth.keys()) {
    if (earliestMonth === null || month < earliestMonth) earliestMonth = month;
  }

  const currencyRow = dbi
    .select()
    .from(schema.settings)
    .all()
    .find((s) => s.key === "currency");

  return {
    accounts,
    groups,
    categories,
    categoryIds: categories.map((c) => c.id),
    assignmentsByMonth,
    txnsByMonth,
    earliestMonth,
    currency: currencyRow?.value ?? DEFAULT_CURRENCY,
  };
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
 */
export class SnapshotStore {
  private data: BudgetData | null = null;
  private snapshots = new Map<string, MonthSnapshot>();
  private cursor: Cursor = {
    month: null,
    prevAvailable: new Map(),
    cumulativeFunds: 0,
  };

  constructor(private loader: () => BudgetData) {}

  getData(): BudgetData {
    if (!this.data) this.data = this.loader();
    return this.data;
  }

  invalidate(): void {
    this.data = null;
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
      const snapshot = computeMonthSnapshot({
        categoryIds: data.categoryIds,
        prevAvailable: this.cursor.prevAvailable,
        assignedByCategory: data.assignmentsByMonth.get(m) ?? new Map(),
        monthTransactions: data.txnsByMonth.get(m) ?? [],
        cumulativeOnBudgetFundsThroughPrevMonth: this.cursor.cumulativeFunds,
        accounts: data.accounts,
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

// App-wide singleton backed by the real database.
const store = new SnapshotStore(() => loadBudgetData(db));

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
          return {
            id: category.id,
            name: category.name,
            assigned: cell.assigned,
            activity: cell.activity,
            available: cell.available,
            monthlyTarget: category.monthlyTarget,
            goal,
          };
        });
      return { id: group.id, name: group.name, categories: cats };
    })
    .filter((group) => group.categories.length > 0);

  return {
    month,
    months,
    currency: data.currency,
    readyToAssign: snapshot.readyToAssign,
    totalUnderfunded,
    groups,
  };
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
      balance: balanceById.get(a.id) ?? 0,
    }));
}

export interface SidebarData {
  currency: string;
  budget: AccountBalance[];
  tracking: AccountBalance[];
  closed: AccountBalance[];
  budgetTotal: number;
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
  const budget = open.filter((a) => a.type !== "tracking");
  const tracking = open.filter((a) => a.type === "tracking");
  const budgetTotal = sumBalances(budget);
  const trackingTotal = sumBalances(tracking);

  return {
    currency: getCurrency(dbi),
    budget,
    tracking,
    closed,
    budgetTotal,
    trackingTotal,
    netWorth: budgetTotal + trackingTotal,
  };
}

export interface AccountDetail {
  id: number;
  name: string;
  type: AccountType;
  closed: boolean;
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
 * so it's simply uncategorized.
 */
export function createAccount(dbi: DB, input: CreateAccountInput): number {
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

/** Find the mirror leg of a transfer by (account, other account, date, amount) — the schema has no pair id, per PLAN.md. */
function findMirrorLeg(dbi: DB, leg: TransferRow): TransferRow | null {
  if (leg.transferAccountId == null) return null;
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

/** Insert the checked import rows (uncategorized unless matched), stamping import_hash. */
export function commitImport(dbi: DB, accountId: number, rows: ImportInsertRow[]): number {
  if (rows.length === 0) return 0;
  dbi
    .insert(schema.transactions)
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
  return rows.length;
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

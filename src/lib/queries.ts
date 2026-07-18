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
import { eq } from "drizzle-orm";
import {
  computeGoalStatus,
  computeMonthSnapshot,
  monthKey,
  nextMonthKey,
  type AccountInfo,
  type GoalStatus,
  type MonthSnapshot,
  type TxnInput,
} from "./budget-math";
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

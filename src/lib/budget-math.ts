/**
 * Pure budget math (YNAB semantics). No DB imports — the DB layer feeds in
 * plain data and caches the result per month.
 *
 * Amounts are integers in minor currency units (Rappen), +inflow / -outflow.
 */

export type AccountType = "checking" | "savings" | "cash" | "credit" | "tracking";

export interface AccountInfo {
  id: number;
  type: AccountType;
  /** For type "credit": the category that categorized spend on this account feeds. */
  paymentCategoryId: number | null;
}

export interface TxnInput {
  accountId: number;
  categoryId: number | null;
  amount: number;
  /** Set for transfer legs — the account on the other side of the transfer. */
  transferAccountId?: number | null;
}

export interface CategorySnapshot {
  assigned: number;
  activity: number;
  available: number;
}

export interface MonthSnapshot {
  categories: Map<number, CategorySnapshot>;
  readyToAssign: number;
  /** Carry this forward as `cumulativeOnBudgetFundsThroughPrevMonth` for the next month. */
  cumulativeOnBudgetFunds: number;
}

export interface GoalStatus {
  met: boolean;
  remaining: number;
}

/** available(cat, M) = max(0, available(cat, M-1)) + assigned(cat, M) + activity(cat, M) */
export function computeAvailable(
  prevAvailable: number,
  assigned: number,
  activity: number
): number {
  return Math.max(0, prevAvailable) + assigned + activity;
}

/**
 * activity(cat, M) for every category touched this month, across on-budget
 * accounts. Two credit-card effects feed the linked payment category:
 *  - Categorized spend on a credit account *increases* its payment category's
 *    available (YNAB's "immediate category funding" — the money owed is set
 *    aside so the eventual payment is funded).
 *  - A payment transfer from an on-budget account into the credit account
 *    *reduces* the payment category's available by the payment amount (that
 *    set-aside money is now spent paying the card). The mirror image.
 */
export function computeCategoryActivity(
  transactions: TxnInput[],
  accounts: Map<number, AccountInfo>
): Map<number, number> {
  const activity = new Map<number, number>();
  const bump = (categoryId: number, delta: number) =>
    activity.set(categoryId, (activity.get(categoryId) ?? 0) + delta);

  for (const txn of transactions) {
    const account = accounts.get(txn.accountId);
    if (!account || account.type === "tracking") continue;

    // Transfer leg (no category). A transfer into a credit account from an
    // on-budget account is a card payment: reduce the payment category. The
    // credit leg carries a positive amount (funds arriving to clear debt), so
    // subtracting it lowers the payment category's available.
    if (txn.categoryId == null) {
      if (
        account.type === "credit" &&
        account.paymentCategoryId != null &&
        txn.transferAccountId != null
      ) {
        const other = accounts.get(txn.transferAccountId);
        if (other && other.type !== "tracking") {
          bump(account.paymentCategoryId, -txn.amount);
        }
      }
      continue;
    }

    bump(txn.categoryId, txn.amount);

    if (
      account.type === "credit" &&
      account.paymentCategoryId != null &&
      account.paymentCategoryId !== txn.categoryId
    ) {
      bump(account.paymentCategoryId, -txn.amount);
    }
  }

  return activity;
}

/** Net movement in on-budget accounts this month (tracking accounts excluded). */
export function computeOnBudgetFunds(
  transactions: TxnInput[],
  accounts: Map<number, AccountInfo>
): number {
  let total = 0;
  for (const txn of transactions) {
    const account = accounts.get(txn.accountId);
    if (!account || account.type === "tracking") continue;
    total += txn.amount;
  }
  return total;
}

/**
 * Compute one month's snapshot from the previous month's carry-forward state.
 * Costs O(this month's transactions + category count) — never rewalks history.
 */
export function computeMonthSnapshot(params: {
  categoryIds: number[];
  prevAvailable: Map<number, number>;
  assignedByCategory: Map<number, number>;
  monthTransactions: TxnInput[];
  cumulativeOnBudgetFundsThroughPrevMonth: number;
  accounts: Map<number, AccountInfo>;
}): MonthSnapshot {
  const {
    categoryIds,
    prevAvailable,
    assignedByCategory,
    monthTransactions,
    cumulativeOnBudgetFundsThroughPrevMonth,
    accounts,
  } = params;

  const activity = computeCategoryActivity(monthTransactions, accounts);
  const categories = new Map<number, CategorySnapshot>();
  let totalAvailable = 0;

  for (const categoryId of categoryIds) {
    const prev = prevAvailable.get(categoryId) ?? 0;
    const assigned = assignedByCategory.get(categoryId) ?? 0;
    const act = activity.get(categoryId) ?? 0;
    const available = computeAvailable(prev, assigned, act);
    categories.set(categoryId, { assigned, activity: act, available });
    totalAvailable += available;
  }

  const cumulativeOnBudgetFunds =
    cumulativeOnBudgetFundsThroughPrevMonth + computeOnBudgetFunds(monthTransactions, accounts);

  return {
    categories,
    readyToAssign: cumulativeOnBudgetFunds - totalAvailable,
    cumulativeOnBudgetFunds,
  };
}

/** Monthly goal: met when assigned(cat, M) >= target. Spending is irrelevant. */
export function computeGoalStatus(
  monthlyTarget: number | null,
  assigned: number
): GoalStatus | null {
  if (monthlyTarget == null) return null;
  const remaining = Math.max(0, monthlyTarget - assigned);
  return { met: remaining === 0, remaining };
}

/** YYYY-MM-DD -> YYYY-MM */
export function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** The next month key after `month` (YYYY-MM). */
export function nextMonthKey(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, mon - 1 + 1, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The previous month key before `month` (YYYY-MM). */
export function prevMonthKey(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, mon - 1 - 1, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

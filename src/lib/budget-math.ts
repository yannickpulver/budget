/**
 * Pure budget math (YNAB semantics). No DB imports — the DB layer feeds in
 * plain data and caches the result per month.
 *
 * Amounts are integers in minor currency units (Rappen), +inflow / -outflow.
 */

export type AccountType = "checking" | "savings" | "cash" | "credit" | "giftcard" | "tracking";

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

export type TargetType = "monthly" | "balance";

export interface GoalStatus {
  met: boolean;
  remaining: number;
}

export interface BalanceGoalStatus extends GoalStatus {
  /** Behind pace this month: not met and this month's assignment is short of the suggested contribution. */
  underfunded: boolean;
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

/** A transaction plus the display fields needed to explain an activity number. */
export interface ActivityTxnInput extends TxnInput {
  id: number;
  date: string;
  payee: string;
}

/** One line item contributing to a category's activity total. */
export interface ActivityEntry {
  id: number;
  date: string;
  payee: string;
  amount: number;
}

/**
 * Same branching as `computeCategoryActivity`, but returns the underlying
 * transactions/feed entries behind each category's number instead of just the
 * sum — powers the Activity-cell tooltip. Mirrors the other function exactly
 * so each category's entries always sum to its `computeCategoryActivity`
 * total, including the credit-card payment-category feed (categorized spend
 * on the card, and payment transfers that reduce it).
 */
export function computeCategoryActivityEntries(
  transactions: ActivityTxnInput[],
  accounts: Map<number, AccountInfo>,
  accountNames: Map<number, string>
): Map<number, ActivityEntry[]> {
  const entries = new Map<number, ActivityEntry[]>();
  const push = (categoryId: number, entry: ActivityEntry) => {
    const list = entries.get(categoryId);
    if (list) list.push(entry);
    else entries.set(categoryId, [entry]);
  };

  for (const txn of transactions) {
    const account = accounts.get(txn.accountId);
    if (!account || account.type === "tracking") continue;

    if (txn.categoryId == null) {
      if (
        account.type === "credit" &&
        account.paymentCategoryId != null &&
        txn.transferAccountId != null
      ) {
        const other = accounts.get(txn.transferAccountId);
        if (other && other.type !== "tracking") {
          push(account.paymentCategoryId, {
            id: txn.id,
            date: txn.date,
            payee: `Payment: ${accountNames.get(txn.transferAccountId) ?? "account"}`,
            amount: -txn.amount,
          });
        }
      }
      continue;
    }

    push(txn.categoryId, { id: txn.id, date: txn.date, payee: txn.payee, amount: txn.amount });

    if (
      account.type === "credit" &&
      account.paymentCategoryId != null &&
      account.paymentCategoryId !== txn.categoryId
    ) {
      push(account.paymentCategoryId, {
        id: txn.id,
        date: txn.date,
        payee: txn.payee,
        amount: -txn.amount,
      });
    }
  }

  return entries;
}

/**
 * Net movement in on-budget accounts this month. Two exclusions:
 *  - Tracking accounts are off-budget entirely.
 *  - Credit accounts, because a card's balance is *already* represented in the
 *    budget through its payment category (spend feeds the category, payments
 *    drain it). Counting the card balance here too would double-count it, and
 *    since Ready to Assign is `funds − Σ available`, the two copies don't
 *    cancel — they compound, skewing RTA by the card balance in the same
 *    direction. Only the on-budget cash side of a card payment counts.
 */
export function computeOnBudgetFunds(
  transactions: TxnInput[],
  accounts: Map<number, AccountInfo>
): number {
  let total = 0;
  for (const txn of transactions) {
    const account = accounts.get(txn.accountId);
    if (!account || account.type === "tracking" || account.type === "credit") continue;
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
  /**
   * Flat minor-unit offset added to this month's Ready to Assign only (never
   * to any category available, nor to the carried cumulative-funds state).
   * Used for post-migration RTA alignment — see `rta_adjustment` in
   * queries.ts. Defaults to 0.
   */
  readyToAssignAdjustment?: number;
  /**
   * Net amount assigned in months *after* this one — YNAB's "Assigned in the
   * Future". Money earmarked for next month is already spoken for, so it must
   * leave this month's Ready to Assign instead of looking spendable twice.
   * No double-count: those assignments land in their own month's
   * `totalAvailable`, which only that month's snapshot sees.
   *
   * Floored at 0 by the caller's intent — a *negative* net (funds released in
   * a later month) must not inflate this month's RTA, since money freed up in
   * September cannot be spent in July. Defaults to 0.
   */
  assignedInFutureMonths?: number;
}): MonthSnapshot {
  const {
    categoryIds,
    prevAvailable,
    assignedByCategory,
    monthTransactions,
    cumulativeOnBudgetFundsThroughPrevMonth,
    accounts,
    readyToAssignAdjustment = 0,
    assignedInFutureMonths = 0,
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
    readyToAssign:
      cumulativeOnBudgetFunds -
      totalAvailable -
      Math.max(0, assignedInFutureMonths) +
      readyToAssignAdjustment,
    cumulativeOnBudgetFunds,
  };
}

/**
 * Monthly goal. Met when either the goal was explicitly funded this month
 * (the "Fund" button — see `funded`) or assigned(cat, M) >= target. Spending
 * is irrelevant.
 *
 * `funded` lets one month's contribution satisfy the goal even after money is
 * later spent or reallocated out of the category (which would drag assigned
 * negative). Without it, "to go" is `target - assigned`, capped at the target
 * itself: money moved out never inflates the goal beyond one month's worth, so
 * a target of 500 asks for at most 500 in a month regardless of what was pulled.
 */
export function computeGoalStatus(
  monthlyTarget: number | null,
  assigned: number,
  funded = false
): GoalStatus | null {
  if (monthlyTarget == null) return null;
  if (funded) return { met: true, remaining: 0 };
  const remaining = Math.max(0, Math.min(monthlyTarget, monthlyTarget - assigned));
  return { met: remaining === 0, remaining };
}

/** Months from `year * 12 + monthIndex`, for arithmetic over YYYY-MM keys. */
function monthOrdinal(month: string): number {
  const [year, mon] = month.split("-").map(Number);
  return year * 12 + (mon - 1);
}

/**
 * Balance goal ("save up to a total available of `target`"). Met when this
 * month's `available` (rollover + assigned + activity) reaches the target, or
 * the goal was explicitly funded. When a `targetDate` is set and still ahead,
 * the suggested contribution paces the remainder evenly across the months left
 * (this month through the target month inclusive); otherwise it's the whole
 * remainder. `underfunded` is the pace check: not met and this month's
 * assignment is short of that suggestion.
 */
export function computeBalanceGoalStatus(params: {
  target: number;
  targetDate: string | null;
  month: string;
  assigned: number;
  available: number;
  funded: boolean;
}): BalanceGoalStatus {
  const { target, targetDate, month, assigned, available, funded } = params;
  const met = funded || available >= target;
  // Available carried in plus this month's activity — what's saved regardless
  // of this month's assignment, so the suggestion is "assign this much now".
  const availableBeforeAssignment = available - assigned;
  const totalRemaining = Math.max(0, target - availableBeforeAssignment);
  const hasFutureDate = targetDate != null && targetDate >= month;
  const monthsLeft = hasFutureDate ? monthOrdinal(targetDate) - monthOrdinal(month) + 1 : 1;
  const suggested = hasFutureDate ? Math.ceil(totalRemaining / monthsLeft) : totalRemaining;
  const remaining = met ? 0 : Math.max(0, suggested - assigned);
  return { met, remaining, underfunded: !met && remaining > 0 };
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

/**
 * Display-only: whether something hidden from `hiddenFrom` (YYYY-MM) onward
 * (an account or a category) should be hidden when viewing `month`.
 * Lexicographic compare is exact for zero-padded YYYY-MM keys.
 */
export function isHiddenForMonth(hiddenFrom: string | null, month: string): boolean {
  return hiddenFrom != null && month >= hiddenFrom;
}

/** Extracts the YYYY-MM month from a `/budget/<month>` pathname, or null if absent. */
export function monthFromPathname(pathname: string): string | null {
  const match = /^\/budget\/(\d{4}-\d{2})/.exec(pathname);
  return match ? match[1] : null;
}

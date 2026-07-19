/**
 * Credit-card payment category reconciliation.
 *
 * YNAB's internal credit-card mechanics (immediate category funding,
 * un-exported adjustments, etc.) aren't captured by the Register/Plan CSV
 * export, so our from-scratch replay of a payment category's Available can
 * drift from what YNAB itself reports. YNAB's Plan.csv states the correct
 * Available per category-month directly — this module compares our computed
 * value against it at one month and produces the delta needed to snap it
 * exactly, expressed as an additional assignment amount (booking it as an
 * assignment — rather than overwriting Available directly — keeps the
 * category's ledger consistent with how every other number in the budget is
 * derived: assigned + activity + prior available).
 *
 * Pure — no DB access — driven entirely by `planAvailable` data. No
 * hardcoded category or account names.
 */
import { computeMonthSnapshot, type AccountInfo, type TxnInput } from "./budget-math";
import type { CreditCardLink, PlanAvailableEntry } from "./ynab-import";

export interface PaymentCategoryAdjustment {
  accountName: string;
  categoryId: number;
  month: string;
  planAvailable: number;
  ourAvailable: number;
  /** Amount to add to the category's assignment for `month`. Negative releases funds to Ready to Assign. */
  delta: number;
}

/**
 * For every credit-card payment category, compare our computed Available at
 * `month` against YNAB's own Plan.csv Available for that same month and
 * produce the adjustment needed to snap it exactly. Categories with no
 * Plan.csv entry at `month` (e.g. closed before the export's final month)
 * are skipped rather than guessed at.
 */
export function computePaymentCategoryAdjustments(params: {
  creditCardLinks: CreditCardLink[];
  categoryIdByKey: Map<string, number>;
  planAvailable: PlanAvailableEntry[];
  ourAvailableAtMonth: Map<number, number>;
  month: string;
}): PaymentCategoryAdjustment[] {
  const { creditCardLinks, categoryIdByKey, planAvailable, ourAvailableAtMonth, month } = params;

  const planAvailableByCategory = new Map<number, number>();
  for (const entry of planAvailable) {
    if (entry.month !== month) continue;
    const categoryId = categoryIdByKey.get(`${entry.groupName}::${entry.categoryName}`);
    if (categoryId != null) planAvailableByCategory.set(categoryId, entry.available);
  }

  const adjustments: PaymentCategoryAdjustment[] = [];
  for (const link of creditCardLinks) {
    const categoryId = categoryIdByKey.get(`${link.paymentGroupName}::${link.paymentCategoryName}`);
    if (categoryId == null) continue;
    const planValue = planAvailableByCategory.get(categoryId);
    if (planValue == null) continue;
    const ourValue = ourAvailableAtMonth.get(categoryId) ?? 0;
    const delta = planValue - ourValue;
    if (delta === 0) continue;
    adjustments.push({
      accountName: link.accountName,
      categoryId,
      month,
      planAvailable: planValue,
      ourAvailable: ourValue,
      delta,
    });
  }
  return adjustments;
}

/**
 * Walk every month chronologically and, at each month where a payment
 * category has a Plan.csv Available, produce the assignment delta that snaps
 * our computed Available to YNAB's value — for EVERY month, not just the
 * export's last one. YNAB's un-exported credit-card mechanics leave phantom
 * Available in these categories in every historical month; snapping only the
 * final month leaves the earlier months (and their Ready to Assign) wrong.
 *
 * The walk carries each month's snapped Available forward (overriding the
 * payment categories to their Plan value) so month m+1's carry-in is
 * `max(0, plan(m))` — exactly the clamp `computeMonthSnapshot` applies — and
 * the delta booked at m+1 is computed against that already-corrected history.
 * Because each month is snapped independently to its own Plan value, a
 * negative Plan Available (YNAB does emit these for payment categories) is
 * reproduced exactly rather than being lost to the carry clamp.
 *
 * Returns every delta needed, in chronological order. The caller books each
 * as an additional assignment (see `adjustAssignment`); this function is pure
 * and never touches the DB.
 */
export function computePaymentCategoryAdjustmentsAllMonths(params: {
  months: string[];
  categoryIds: number[];
  accounts: Map<number, AccountInfo>;
  /** Base assignment per `${month}:${categoryId}` (before any reconciliation delta). */
  assignmentByKey: Map<string, number>;
  txnsByMonth: Map<string, TxnInput[]>;
  creditCardLinks: CreditCardLink[];
  categoryIdByKey: Map<string, number>;
  planAvailable: PlanAvailableEntry[];
}): PaymentCategoryAdjustment[] {
  const {
    months,
    categoryIds,
    accounts,
    assignmentByKey,
    txnsByMonth,
    creditCardLinks,
    categoryIdByKey,
    planAvailable,
  } = params;

  const paymentCategoryIds = new Set<number>();
  for (const link of creditCardLinks) {
    const id = categoryIdByKey.get(`${link.paymentGroupName}::${link.paymentCategoryName}`);
    if (id != null) paymentCategoryIds.add(id);
  }

  const all: PaymentCategoryAdjustment[] = [];
  let prevAvailable = new Map<number, number>();
  let cumulativeFunds = 0;

  for (const month of months) {
    const assignedByCategory = new Map<number, number>();
    for (const categoryId of categoryIds) {
      const amount = assignmentByKey.get(`${month}:${categoryId}`);
      if (amount != null) assignedByCategory.set(categoryId, amount);
    }

    const snapshot = computeMonthSnapshot({
      categoryIds,
      prevAvailable,
      assignedByCategory,
      monthTransactions: txnsByMonth.get(month) ?? [],
      cumulativeOnBudgetFundsThroughPrevMonth: cumulativeFunds,
      accounts,
    });

    const ourAvailableAtMonth = new Map<number, number>();
    for (const categoryId of paymentCategoryIds) {
      ourAvailableAtMonth.set(categoryId, snapshot.categories.get(categoryId)?.available ?? 0);
    }

    const monthAdjustments = computePaymentCategoryAdjustments({
      creditCardLinks,
      categoryIdByKey,
      planAvailable,
      ourAvailableAtMonth,
      month,
    });

    // Carry each category's Available forward, overriding the payment
    // categories we just snapped to their exact Plan value so the next
    // month's replay (and its delta) sees the corrected history.
    const nextAvailable = new Map<number, number>(
      Array.from(snapshot.categories, ([id, s]) => [id, s.available])
    );
    for (const adjustment of monthAdjustments) {
      nextAvailable.set(adjustment.categoryId, adjustment.planAvailable);
      all.push(adjustment);
    }
    prevAvailable = nextAvailable;
    cumulativeFunds = snapshot.cumulativeOnBudgetFunds;
  }

  return all;
}

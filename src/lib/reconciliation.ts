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

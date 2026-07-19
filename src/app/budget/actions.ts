"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { adjustAssignment, invalidateBudgetCache } from "@/lib/queries";
import { isValidNumber } from "@/lib/validation";

const BUDGET_ROUTE = "/budget/[month]";

function refresh(): void {
  invalidateBudgetCache();
  // Carry-forward means a write in one month affects every later month, so
  // revalidate the whole dynamic route rather than a single month.
  revalidatePath(BUDGET_ROUTE, "page");
}

function upsertAssignment(month: string, categoryId: number, amount: number): void {
  db.insert(schema.assignments)
    .values({ month, categoryId, amount })
    .onConflictDoUpdate({
      target: [schema.assignments.month, schema.assignments.categoryId],
      set: { amount },
    })
    .run();
}

/** Set the assigned amount (minor units) for a category in a month. */
export async function setAssigned(
  month: string,
  categoryId: number,
  amount: number
): Promise<void> {
  if (!isValidNumber(amount)) return;
  upsertAssignment(month, categoryId, Math.round(amount));
  refresh();
}

/** Set or clear (null) a category's monthly assignment target. */
export async function setMonthlyTarget(
  categoryId: number,
  amount: number | null
): Promise<void> {
  if (amount != null && !isValidNumber(amount)) return;
  db.update(schema.categories)
    .set({ monthlyTarget: amount == null ? null : Math.round(amount) })
    .where(eq(schema.categories.id, categoryId))
    .run();
  refresh();
}

/**
 * Move money between two sides of a month's budget — either side may be
 * `null` for Ready to Assign. Both adjustments happen in one transaction:
 * the source's assigned amount goes down by `amount`, the destination's
 * goes up by it. A `null` side is skipped since RTA isn't a stored row —
 * reducing (or growing) the other side's assignment alone moves the money
 * to (or from) it implicitly.
 */
export async function moveMoney(
  month: string,
  fromCategoryId: number | null,
  toCategoryId: number | null,
  amount: number
): Promise<void> {
  if (!isValidNumber(amount) || amount <= 0) return;
  if (fromCategoryId === toCategoryId) return;
  const rounded = Math.round(amount);
  db.transaction((tx) => {
    if (fromCategoryId != null) adjustAssignment(tx, month, fromCategoryId, -rounded);
    if (toCategoryId != null) adjustAssignment(tx, month, toCategoryId, rounded);
  });
  refresh();
}

/** Top the month's assignment up to the category's monthly target. */
export async function fundToGoal(month: string, categoryId: number): Promise<void> {
  const category = db
    .select({ monthlyTarget: schema.categories.monthlyTarget })
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .get();
  if (!category || category.monthlyTarget == null) return;
  if (!isValidNumber(category.monthlyTarget)) return;
  upsertAssignment(month, categoryId, category.monthlyTarget);
  refresh();
}

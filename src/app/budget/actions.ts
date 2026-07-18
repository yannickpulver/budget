"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { invalidateBudgetCache } from "@/lib/queries";
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

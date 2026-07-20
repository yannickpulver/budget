"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { computeGoalStatus } from "@/lib/budget-math";
import { adjustAssignment } from "@/lib/queries";
import { withUndoStep } from "@/lib/undo";
import { isValidNumber } from "@/lib/validation";
// Shared refresh (revalidates the layout too, keeping the undo toolbar fresh);
// its `/budget/[month]` page revalidation already covers carry-forward, which
// makes a write in one month affect every later month.
import { refresh } from "../accounts/refresh";

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
  withUndoStep("Assign", () => upsertAssignment(month, categoryId, Math.round(amount)));
  refresh();
}

/** Set or clear (null) a category's monthly assignment target. */
export async function setMonthlyTarget(
  categoryId: number,
  amount: number | null
): Promise<void> {
  if (amount != null && !isValidNumber(amount)) return;
  withUndoStep("Set target", () =>
    db
      .update(schema.categories)
      .set({ monthlyTarget: amount == null ? null : Math.round(amount) })
      .where(eq(schema.categories.id, categoryId))
      .run()
  );
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
  withUndoStep("Move money", () =>
    db.transaction((tx) => {
      if (fromCategoryId != null) adjustAssignment(tx, month, fromCategoryId, -rounded);
      if (toCategoryId != null) adjustAssignment(tx, month, toCategoryId, rounded);
    })
  );
  refresh();
}

/**
 * Fund a category's monthly goal: add this month's remaining goal amount (the
 * capped "to go", at most one month's target) and mark the goal funded for the
 * month. Adds rather than sets-to-target, so money pulled out of the category
 * is never re-injected; the funded flag keeps the goal met even if the money is
 * later spent or reallocated out (see `computeGoalStatus`).
 */
export async function fundToGoal(month: string, categoryId: number): Promise<void> {
  const category = db
    .select({ monthlyTarget: schema.categories.monthlyTarget })
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .get();
  if (!category || category.monthlyTarget == null) return;
  const target = category.monthlyTarget;
  if (!isValidNumber(target)) return;

  const assignedRow = db
    .select({ amount: schema.assignments.amount, goalFunded: schema.assignments.goalFunded })
    .from(schema.assignments)
    .where(and(eq(schema.assignments.month, month), eq(schema.assignments.categoryId, categoryId)))
    .get();
  const remaining =
    computeGoalStatus(target, assignedRow?.amount ?? 0, assignedRow?.goalFunded ?? false)?.remaining ?? 0;
  if (remaining === 0) return;

  withUndoStep("Fund to target", () => {
    adjustAssignment(db, month, categoryId, remaining);
    db.update(schema.assignments)
      .set({ goalFunded: true })
      .where(and(eq(schema.assignments.month, month), eq(schema.assignments.categoryId, categoryId)))
      .run();
  });
  refresh();
}

/**
 * Clear the "funded this month" flag so the goal re-opens for the month. Only
 * touches the flag — the money that was assigned stays put (use Undo to revert
 * the assignment itself).
 */
export async function resetGoalFunding(month: string, categoryId: number): Promise<void> {
  withUndoStep("Reset goal funding", () =>
    db
      .update(schema.assignments)
      .set({ goalFunded: false })
      .where(and(eq(schema.assignments.month, month), eq(schema.assignments.categoryId, categoryId)))
      .run()
  );
  refresh();
}

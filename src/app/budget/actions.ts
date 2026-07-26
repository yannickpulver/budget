"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { adjustAssignment, currentMonth, getBudgetView } from "@/lib/queries";
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

/** Set or clear (null) a category's monthly assignment target. Resets it to the monthly goal type. */
export async function setMonthlyTarget(
  categoryId: number,
  amount: number | null
): Promise<void> {
  if (amount != null && !isValidNumber(amount)) return;
  withUndoStep("Set target", () =>
    db
      .update(schema.categories)
      .set({
        monthlyTarget: amount == null ? null : Math.round(amount),
        targetType: "monthly",
        targetDate: null,
      })
      .where(eq(schema.categories.id, categoryId))
      .run()
  );
  refresh();
}

/**
 * Set a category's savings-target (balance) goal: save up to `amount` total
 * available, optionally pacing toward `targetDate` (YYYY-MM, null = no deadline).
 */
export async function setBalanceTarget(
  categoryId: number,
  amount: number,
  targetDate: string | null
): Promise<void> {
  if (!isValidNumber(amount)) return;
  const date = targetDate != null && /^\d{4}-\d{2}$/.test(targetDate) ? targetDate : null;
  withUndoStep("Set savings target", () =>
    db
      .update(schema.categories)
      .set({ monthlyTarget: Math.round(amount), targetType: "balance", targetDate: date })
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
 * Fund a category's goal for the month and mark it funded. Assigns this
 * month's remaining goal amount — for monthly goals the capped "to go" (at most
 * one month's target); for balance goals the suggested contribution to stay on
 * pace. Adds rather than sets-to-target, so money pulled out is never
 * re-injected; the funded flag keeps the goal met even if the money is later
 * spent or reallocated out (see `computeGoalStatus`/`computeBalanceGoalStatus`).
 */
export async function fundToGoal(month: string, categoryId: number): Promise<void> {
  const category = getBudgetView(month)
    .groups.flatMap((g) => g.categories)
    .find((c) => c.id === categoryId);
  const remaining = category?.goal?.remaining ?? 0;
  if (remaining <= 0) return;

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
 * Close a finished category (a trip, a one-off purchase): release its remaining
 * Available back to Ready to Assign (by decrementing this month's assignment by
 * the Available amount), clear its target, and hide it. No-op when Available is
 * negative — cover the overspend first. Only allowed from the current month:
 * hiding is global, so releasing a past month's Available could silently
 * overdraw a later month, and a future month would strand today's Available.
 */
export async function closeCategory(month: string, categoryId: number): Promise<void> {
  if (month !== currentMonth()) return;
  const category = getBudgetView(month)
    .groups.flatMap((g) => g.categories)
    .find((c) => c.id === categoryId);
  if (!category || category.available < 0) return;
  const available = category.available;

  withUndoStep("Close category", () =>
    db.transaction((tx) => {
      if (available > 0) adjustAssignment(tx, month, categoryId, -available);
      tx.update(schema.categories)
        .set({ monthlyTarget: null, targetType: "monthly", targetDate: null, hidden: true })
        .where(eq(schema.categories.id, categoryId))
        .run();
    })
  );
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

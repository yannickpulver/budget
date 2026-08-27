import { evaluateMoneyExpression, formatMoney } from "@/lib/currency";
import type { TransferTarget } from "@/lib/queries";
import {
  createTransactionAction,
  createTransferAction,
  updateTransactionAction,
  type ActionResult,
} from "../actions";
import type { CategorySelection } from "./category-transfer-select";

/**
 * Field parsing, validation and the save calls shared by the register's three
 * editors: the desktop inline row, the mobile transaction sheet, and the
 * desktop add row. Every one of them writes through the functions here, so
 * "what counts as a valid transaction" is defined exactly once.
 */

export interface AmountFields {
  outflow: string;
  inflow: string;
}

export function amountToFields(amount: number): AmountFields {
  if (amount < 0) return { outflow: formatMoney(-amount), inflow: "" };
  if (amount > 0) return { outflow: "", inflow: formatMoney(amount) };
  return { outflow: "", inflow: "" };
}

function fieldsToAmount(fields: AmountFields): number | null {
  if (fields.outflow.trim() !== "") {
    const parsed = evaluateMoneyExpression(fields.outflow);
    return parsed == null ? null : -Math.abs(parsed);
  }
  if (fields.inflow.trim() !== "") {
    const parsed = evaluateMoneyExpression(fields.inflow);
    return parsed == null ? null : Math.abs(parsed);
  }
  return 0; // both empty — caller rejects 0 on commit
}

/** "YYYY-MM-DD" -> "dd.mm.yyyy"; passes through anything that doesn't parse. */
export function formatDateDisplay(isoDate: string): string {
  const parts = isoDate.split("-");
  if (parts.length !== 3) return isoDate;
  const [year, month, day] = parts;
  return `${day}.${month}.${year}`;
}

/** Snapshot of everything `updateTransactionAction` persists, used to detect no-op commits. */
export interface Committed {
  date: string;
  payee: string;
  categoryId: number | null;
  memo: string;
  amount: number;
}

export function isUnchanged(next: Committed, prev: Committed): boolean {
  return (
    next.date === prev.date &&
    next.payee === prev.payee &&
    next.categoryId === prev.categoryId &&
    next.memo === prev.memo &&
    next.amount === prev.amount
  );
}

/**
 * Turns raw field state into the amount to persist, or the message to show.
 * The order of the checks is the order the register has always reported them.
 */
export function validateAmountAndDate(
  amountFields: AmountFields,
  date: string
): { ok: true; amount: number } | { ok: false; error: string } {
  const amount = fieldsToAmount(amountFields);
  if (amount == null) return { ok: false, error: "Amount is not a valid number." };
  if (amount === 0) return { ok: false, error: "Enter an outflow or inflow amount." };
  if (!date) return { ok: false, error: "Date is required." };
  return { ok: true, amount };
}

/** Persists an edit to an existing row. */
export function saveTransaction(
  rowId: number,
  accountId: number,
  transferAccountId: number | null,
  next: Committed,
  cleared: boolean
): Promise<ActionResult> {
  return updateTransactionAction(rowId, accountId, transferAccountId, { ...next, cleared });
}

/**
 * Creates a new row from the add-transaction form state — a transfer when the
 * category picker points at another account, a plain transaction otherwise.
 */
export function createTransaction(input: {
  accountId: number;
  date: string;
  payee: string;
  memo: string;
  amount: number;
  selection: CategorySelection;
  transferTargets: TransferTarget[];
}): Promise<ActionResult> {
  const { accountId, date, payee, memo, amount, selection, transferTargets } = input;
  if (selection.kind === "transfer") {
    const needsLinkedCategory =
      transferTargets.find((a) => a.id === selection.accountId)?.type === "tracking" &&
      selection.categoryId == null;
    if (needsLinkedCategory) {
      return Promise.resolve({ ok: false, error: "Choose a budget category for this transfer." });
    }
    return createTransferAction({
      fromAccountId: accountId,
      toAccountId: selection.accountId,
      date,
      amount,
      memo,
      cleared: true,
      categoryId: selection.categoryId,
    });
  }
  return createTransactionAction({
    accountId,
    date,
    payee,
    memo,
    cleared: true,
    amount,
    categoryId: selection.kind === "category" ? selection.categoryId : null,
  });
}

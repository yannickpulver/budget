"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import type { AccountType } from "@/lib/budget-math";
import {
  createAccount as createAccountRow,
  createTransaction as createTransactionRow,
  createTransfer as createTransferRow,
  deleteAccount as deleteAccountRow,
  deleteTransaction as deleteTransactionRow,
  getAccountDetail,
  renameAccount as renameAccountRow,
  reorderAccounts as reorderAccountsRow,
  setAccountBalance,
  setAccountClosed,
  setAccountHiddenFrom,
  setAccountIcon,
  setAccountType,
  toggleTransactionCleared,
  updateTransaction as updateTransactionRow,
  invalidateBudgetCache,
  type TransactionEditInput,
} from "@/lib/queries";
import { refreshPayeeIcons, type PayeeIconRefreshResult } from "@/lib/payee-icons";
import { withUndoStep } from "@/lib/undo";
import { isValidNumber } from "@/lib/validation";
// `refresh` lives here (not this file) because every export of a "use
// server" module must itself be an async server action.
import { refresh } from "./refresh";

export type ActionResult = { ok: true } | { ok: false; error: string };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface CreateAccountFormInput {
  name: string;
  type: AccountType;
  /** Minor units. */
  startingBalance: number;
}

export async function createAccountAction(
  input: CreateAccountFormInput
): Promise<ActionResult & { id?: number }> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Name is required." };

  const id = withUndoStep(`Add account ${name}`, () =>
    createAccountRow(db, {
      name,
      type: input.type,
      startingBalance: Math.round(input.startingBalance),
      date: todayIso(),
    })
  );
  refresh(id);
  return { ok: true, id };
}

export async function renameAccountAction(id: number, name: string): Promise<ActionResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name is required." };
  withUndoStep("Rename account", () => renameAccountRow(db, id, trimmed));
  refresh(id);
  return { ok: true };
}

/** Reorder accounts within one sidebar section (Budget/Giftcards/Tracking) — `ids` is that section's full id list in the new order. */
export async function reorderAccountsAction(ids: number[]): Promise<ActionResult> {
  withUndoStep("Reorder accounts", () => reorderAccountsRow(db, ids));
  refresh();
  return { ok: true };
}

export async function closeAccountAction(id: number): Promise<ActionResult> {
  const detail = getAccountDetail(id, db);
  if (!detail) return { ok: false, error: "Account not found." };
  if (detail.balance !== 0) return { ok: false, error: "Balance must be zero to close an account." };
  withUndoStep("Close account", () => setAccountClosed(db, id, true));
  refresh(id);
  return { ok: true };
}

export async function reopenAccountAction(id: number): Promise<ActionResult> {
  withUndoStep("Reopen account", () => setAccountClosed(db, id, false));
  refresh(id);
  return { ok: true };
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Hides the account from the sidebar starting at `month` (YYYY-MM); earlier
 * months still show it. Display-only — budget math and totals are unaffected.
 */
export async function hideAccountFromMonthAction(id: number, month: string): Promise<ActionResult> {
  if (!MONTH_RE.test(month)) return { ok: false, error: "Invalid month." };
  withUndoStep("Hide account", () => setAccountHiddenFrom(db, id, month));
  refresh(id);
  return { ok: true };
}

/** Clears the hidden-from flag so the account reappears in every month. */
export async function unhideAccountAction(id: number): Promise<ActionResult> {
  withUndoStep("Unhide account", () => setAccountHiddenFrom(db, id, null));
  refresh(id);
  return { ok: true };
}

/**
 * Switching between on-budget and tracking legitimately changes Ready to
 * Assign — that's the point (e.g. flipping a mis-detected investment
 * account to tracking). No special-casing.
 */
export async function updateAccountTypeAction(id: number, type: AccountType): Promise<ActionResult> {
  withUndoStep("Change account type", () => setAccountType(db, id, type));
  refresh(id);
  return { ok: true };
}

/** `icon` is free-text (typically 1-2 emoji chars); `null` resets to the type's default icon. */
export async function updateAccountIconAction(id: number, icon: string | null): Promise<ActionResult> {
  withUndoStep("Change account icon", () => setAccountIcon(db, id, icon));
  refresh(id);
  return { ok: true };
}

/**
 * Books an adjustment transaction so the account balance matches a
 * user-typed target — for tracking accounts whose value isn't derived from
 * priced holdings (see `setAccountBalance` in queries.ts).
 */
export async function setAccountBalanceAction(id: number, targetBalance: number): Promise<ActionResult> {
  if (!isValidNumber(targetBalance)) return { ok: false, error: "Amount is not a valid number." };
  const result = withUndoStep("Adjust balance", () =>
    setAccountBalance(db, id, Math.round(targetBalance))
  );
  if (!result.ok) return result;
  refresh(id);
  return { ok: true };
}

export async function deleteAccountAction(id: number): Promise<ActionResult> {
  const detail = getAccountDetail(id, db);
  if (!detail) return { ok: false, error: "Account not found." };
  if (detail.transactionCount > 0) {
    return { ok: false, error: "Only accounts with no transactions can be deleted." };
  }
  withUndoStep(`Delete account ${detail.name}`, () => deleteAccountRow(db, id));
  invalidateBudgetCache();
  revalidatePath("/", "layout");
  revalidatePath("/budget/[month]", "page");
  return { ok: true };
}

/**
 * Downloads real favicons for the app's payees and caches them (see
 * lib/payee-icons.ts) so the register avatars show them instead of initials.
 * Reaches the network — like `refreshPricesAction`, this is user-triggered.
 * `retryMisses` re-attempts payees that previously produced no icon.
 */
export async function refreshPayeeIconsAction(
  accountId?: number,
  retryMisses?: boolean
): Promise<PayeeIconRefreshResult> {
  const result = await refreshPayeeIcons(db, retryMisses ?? false);
  refresh(accountId);
  return result;
}

export interface TransactionFormInput {
  accountId: number;
  date: string;
  payee: string;
  memo: string;
  cleared: boolean;
  /** Signed minor units (negative = outflow, positive = inflow). */
  amount: number;
  categoryId: number | null;
}

export async function createTransactionAction(input: TransactionFormInput): Promise<ActionResult> {
  if (!input.date) return { ok: false, error: "Date is required." };
  if (input.amount === 0) return { ok: false, error: "Enter an outflow or inflow amount." };
  if (!isValidNumber(input.amount)) return { ok: false, error: "Amount is not a valid number." };

  withUndoStep("Add transaction", () =>
    createTransactionRow(db, {
      accountId: input.accountId,
      date: input.date,
      payee: input.payee.trim(),
      categoryId: input.categoryId,
      memo: input.memo.trim(),
      amount: Math.round(input.amount),
      cleared: input.cleared,
    })
  );
  refresh(input.accountId);
  return { ok: true };
}

export interface TransferFormInput {
  fromAccountId: number;
  toAccountId: number;
  date: string;
  /** Magnitude, minor units. */
  amount: number;
  memo: string;
  cleared: boolean;
  categoryId: number | null;
}

export async function createTransferAction(input: TransferFormInput): Promise<ActionResult> {
  if (!input.date) return { ok: false, error: "Date is required." };
  if (input.amount === 0) return { ok: false, error: "Enter an amount." };
  if (!isValidNumber(input.amount)) return { ok: false, error: "Amount is not a valid number." };
  if (input.fromAccountId === input.toAccountId) {
    return { ok: false, error: "Choose a different account to transfer to." };
  }

  withUndoStep("Add transfer", () =>
    createTransferRow(db, {
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      date: input.date,
      amount: Math.round(Math.abs(input.amount)),
      memo: input.memo.trim(),
      cleared: input.cleared,
      categoryId: input.categoryId,
    })
  );
  refresh(input.fromAccountId, input.toAccountId);
  return { ok: true };
}

export async function updateTransactionAction(
  id: number,
  accountId: number,
  otherAccountId: number | null,
  input: TransactionEditInput
): Promise<ActionResult> {
  if (!input.date) return { ok: false, error: "Date is required." };
  if (input.amount === 0) return { ok: false, error: "Enter an outflow or inflow amount." };
  if (!isValidNumber(input.amount)) return { ok: false, error: "Amount is not a valid number." };

  withUndoStep("Edit transaction", () =>
    updateTransactionRow(db, id, {
      date: input.date,
      payee: input.payee.trim(),
      categoryId: input.categoryId,
      memo: input.memo.trim(),
      amount: Math.round(input.amount),
      cleared: input.cleared,
    })
  );
  refresh(accountId, otherAccountId);
  return { ok: true };
}

export async function deleteTransactionAction(
  id: number,
  accountId: number,
  otherAccountId: number | null
): Promise<void> {
  withUndoStep("Delete transaction", () => deleteTransactionRow(db, id));
  refresh(accountId, otherAccountId);
}

export async function toggleClearedAction(
  id: number,
  accountId: number,
  otherAccountId: number | null
): Promise<void> {
  withUndoStep("Toggle cleared", () => toggleTransactionCleared(db, id));
  refresh(accountId, otherAccountId);
}

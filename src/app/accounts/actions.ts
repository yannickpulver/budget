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
  setAccountClosed,
  setAccountType,
  toggleTransactionCleared,
  updateTransaction as updateTransactionRow,
  invalidateBudgetCache,
  type TransactionEditInput,
} from "@/lib/queries";

export type ActionResult = { ok: true } | { ok: false; error: string };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Every write here can shift budget cache + account balances, so refresh both broadly. */
function refresh(...accountIds: Array<number | null | undefined>): void {
  invalidateBudgetCache();
  revalidatePath("/", "layout"); // sidebar lives in the root layout
  revalidatePath("/budget/[month]", "page");
  for (const id of accountIds) {
    if (id != null) revalidatePath(`/accounts/${id}`, "page");
  }
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

  const id = createAccountRow(db, {
    name,
    type: input.type,
    startingBalance: Math.round(input.startingBalance),
    date: todayIso(),
  });
  refresh(id);
  return { ok: true, id };
}

export async function renameAccountAction(id: number, name: string): Promise<ActionResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name is required." };
  renameAccountRow(db, id, trimmed);
  refresh(id);
  return { ok: true };
}

export async function closeAccountAction(id: number): Promise<ActionResult> {
  const detail = getAccountDetail(id, db);
  if (!detail) return { ok: false, error: "Account not found." };
  if (detail.balance !== 0) return { ok: false, error: "Balance must be zero to close an account." };
  setAccountClosed(db, id, true);
  refresh(id);
  return { ok: true };
}

export async function reopenAccountAction(id: number): Promise<ActionResult> {
  setAccountClosed(db, id, false);
  refresh(id);
  return { ok: true };
}

/**
 * Switching between on-budget and tracking legitimately changes Ready to
 * Assign — that's the point (e.g. flipping a mis-detected investment
 * account to tracking). No special-casing.
 */
export async function updateAccountTypeAction(id: number, type: AccountType): Promise<ActionResult> {
  setAccountType(db, id, type);
  refresh(id);
  return { ok: true };
}

export async function deleteAccountAction(id: number): Promise<ActionResult> {
  const detail = getAccountDetail(id, db);
  if (!detail) return { ok: false, error: "Account not found." };
  if (detail.transactionCount > 0) {
    return { ok: false, error: "Only accounts with no transactions can be deleted." };
  }
  deleteAccountRow(db, id);
  invalidateBudgetCache();
  revalidatePath("/", "layout");
  revalidatePath("/budget/[month]", "page");
  return { ok: true };
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

  createTransactionRow(db, {
    accountId: input.accountId,
    date: input.date,
    payee: input.payee.trim(),
    categoryId: input.categoryId,
    memo: input.memo.trim(),
    amount: Math.round(input.amount),
    cleared: input.cleared,
  });
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
  if (input.fromAccountId === input.toAccountId) {
    return { ok: false, error: "Choose a different account to transfer to." };
  }

  createTransferRow(db, {
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    date: input.date,
    amount: Math.round(Math.abs(input.amount)),
    memo: input.memo.trim(),
    cleared: input.cleared,
    categoryId: input.categoryId,
  });
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

  updateTransactionRow(db, id, {
    date: input.date,
    payee: input.payee.trim(),
    categoryId: input.categoryId,
    memo: input.memo.trim(),
    amount: Math.round(input.amount),
    cleared: input.cleared,
  });
  refresh(accountId, otherAccountId);
  return { ok: true };
}

export async function deleteTransactionAction(
  id: number,
  accountId: number,
  otherAccountId: number | null
): Promise<void> {
  deleteTransactionRow(db, id);
  refresh(accountId, otherAccountId);
}

export async function toggleClearedAction(
  id: number,
  accountId: number,
  otherAccountId: number | null
): Promise<void> {
  toggleTransactionCleared(db, id);
  refresh(accountId, otherAccountId);
}

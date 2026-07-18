"use server";

import { db } from "@/db";
import {
  createHolding,
  deleteHolding,
  refreshHoldingPrices,
  syncHoldingsBalance,
  updateHolding,
  type HoldingInput,
} from "@/lib/queries";
import { isValidNumber } from "@/lib/validation";
import { refresh } from "../refresh";

export type ActionResult = { ok: true } | { ok: false; error: string };

function validateHoldingInput(input: HoldingInput): string | null {
  if (!input.symbol.trim()) return "Symbol is required.";
  if (input.quantity <= 0 || !isValidNumber(input.quantity)) {
    return "Enter a valid quantity greater than zero.";
  }
  return null;
}

export async function createHoldingAction(accountId: number, input: HoldingInput): Promise<ActionResult> {
  const error = validateHoldingInput(input);
  if (error) return { ok: false, error };
  createHolding(db, accountId, {
    symbol: input.symbol.trim(),
    name: input.name.trim(),
    quantity: input.quantity,
  });
  refresh(accountId);
  return { ok: true };
}

export async function updateHoldingAction(
  id: number,
  accountId: number,
  input: HoldingInput
): Promise<ActionResult> {
  const error = validateHoldingInput(input);
  if (error) return { ok: false, error };
  updateHolding(db, id, {
    symbol: input.symbol.trim(),
    name: input.name.trim(),
    quantity: input.quantity,
  });
  refresh(accountId);
  return { ok: true };
}

export async function deleteHoldingAction(id: number, accountId: number): Promise<ActionResult> {
  deleteHolding(db, id);
  refresh(accountId);
  return { ok: true };
}

export type RefreshPricesResult = {
  ok: true;
  updated: number;
  failed: { symbol: string; error: string }[];
};

/** The only server action that reaches the network — see `lib/prices.ts`. */
export async function refreshPricesAction(accountId: number): Promise<RefreshPricesResult> {
  const result = await refreshHoldingPrices(db, accountId);
  refresh(accountId);
  return { ok: true, updated: result.updated.length, failed: result.failed };
}

export type SyncBalanceResult = { ok: true; delta: number } | { ok: false; error: string };

export async function syncBalanceAction(accountId: number): Promise<SyncBalanceResult> {
  const result = syncHoldingsBalance(db, accountId);
  if (result.ok) refresh(accountId);
  return result;
}

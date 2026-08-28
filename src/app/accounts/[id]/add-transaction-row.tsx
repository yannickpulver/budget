"use client";

import { Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PayeeInput } from "@/components/payee-input";
import type { CategoryGroupOption, TransferTarget } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { CategorySelect } from "./category-select";
import { REGISTER_GRID } from "./grid";
import { createTransaction, validateAmountAndDate } from "./transaction-fields";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function AddTransactionRow({
  accountId,
  groups,
  transferTargets,
  payeeSuggestions,
  defaultCategoryId,
}: {
  accountId: number;
  groups: CategoryGroupOption[];
  transferTargets: TransferTarget[];
  payeeSuggestions: string[];
  /** Giftcard accounts default new spend to their own category. */
  defaultCategoryId?: number | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(todayIso());
  const [payee, setPayee] = useState("");
  const [transferTo, setTransferTo] = useState<number | null>(null);
  const [categoryId, setCategoryId] = useState<number | null>(defaultCategoryId ?? null);
  const [memo, setMemo] = useState("");
  const [outflow, setOutflow] = useState("");
  const [inflow, setInflow] = useState("");

  // Only the on-budget leg of a transfer to/from a tracking account carries a
  // budget category — same rule the existing rows apply.
  const transferTarget = transferTo == null ? undefined : transferTargets.find((a) => a.id === transferTo);
  const linkedCategoryEditable = transferTarget?.type === "tracking";

  function reset() {
    setPayee("");
    setTransferTo(null);
    setCategoryId(defaultCategoryId ?? null);
    setMemo("");
    setOutflow("");
    setInflow("");
    setError(null);
  }

  /** Picking a "Transfer: <Account>" payee entry makes this row a transfer. */
  function selectTransfer(toAccountId: number) {
    const target = transferTargets.find((a) => a.id === toAccountId);
    setTransferTo(toAccountId);
    setPayee(`Transfer: ${target?.name ?? "?"}`);
    if (target?.type !== "tracking") setCategoryId(null);
  }

  function save() {
    const validated = validateAmountAndDate({ outflow, inflow }, date);
    if (!validated.ok) {
      setError(validated.error);
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await createTransaction({
        accountId,
        date,
        payee,
        memo,
        amount: validated.amount,
        transferTo,
        categoryId,
        transferTargets,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      reset();
    });
  }

  return (
    <div className="bg-background px-2 py-1.5">
      <div className={cn(REGISTER_GRID, "gap-y-1.5")}>
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.currentTarget.value)}
          className="h-7 text-xs"
        />
        <PayeeInput
          suggestions={payeeSuggestions}
          placeholder="Payee"
          value={payee}
          // Typing over a "Transfer: <Account>" payee makes this a plain
          // transaction again, exactly as it does on an existing row.
          onValueChange={(next) => {
            setPayee(next);
            setTransferTo(null);
          }}
          onEnter={() => save()}
          transferTargets={transferTargets}
          onTransferSelect={selectTransfer}
          className="h-7 text-sm"
        />
        {transferTo != null && !linkedCategoryEditable ? (
          <div className="flex h-8 min-w-0 items-center px-2.5 text-sm text-muted-foreground">
            <span className="min-w-0 truncate">—</span>
          </div>
        ) : (
          <CategorySelect
            groups={groups}
            value={categoryId}
            onChange={setCategoryId}
            includeReadyToAssign={transferTo == null}
            placeholder={transferTo == null ? "Category" : "Budget category"}
            className="w-full min-w-0"
          />
        )}
        <Input
          placeholder="Memo"
          value={memo}
          onChange={(e) => setMemo(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          className="h-7 text-sm"
        />
        <Input
          inputMode="decimal"
          placeholder="Outflow"
          value={outflow}
          onChange={(e) => {
            setOutflow(e.currentTarget.value);
            setInflow("");
          }}
          onKeyDown={(e) => e.key === "Enter" && save()}
          className="h-7 text-right text-sm tabular-nums"
        />
        <Input
          inputMode="decimal"
          placeholder="Inflow"
          value={inflow}
          onChange={(e) => {
            setInflow(e.currentTarget.value);
            setOutflow("");
          }}
          onKeyDown={(e) => e.key === "Enter" && save()}
          className="h-7 text-right text-sm tabular-nums"
        />
        <Button size="icon-sm" variant="outline" onClick={save} disabled={pending} aria-label="Add transaction">
          <Plus className="size-3.5" />
        </Button>
      </div>
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
  );
}

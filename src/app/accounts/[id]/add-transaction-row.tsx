"use client";

import { Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PayeeInput } from "@/components/payee-input";
import type { CategoryGroupOption, TransferTarget } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { CategoryTransferSelect, type CategorySelection } from "./category-transfer-select";
import { REGISTER_GRID } from "./grid";
import { createTransaction, validateAmountAndDate } from "./transaction-fields";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Giftcard accounts default new spend to their own category; others to Ready to Assign. */
function initialSelection(defaultCategoryId: number | null | undefined): CategorySelection {
  return defaultCategoryId != null ? { kind: "category", categoryId: defaultCategoryId } : { kind: "rta" };
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
  defaultCategoryId?: number | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(todayIso());
  const [payee, setPayee] = useState("");
  const [selection, setSelection] = useState<CategorySelection>(() => initialSelection(defaultCategoryId));
  const [memo, setMemo] = useState("");
  const [outflow, setOutflow] = useState("");
  const [inflow, setInflow] = useState("");

  function reset() {
    setPayee("");
    setSelection(initialSelection(defaultCategoryId));
    setMemo("");
    setOutflow("");
    setInflow("");
    setError(null);
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
        selection,
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
          onValueChange={setPayee}
          onEnter={() => save()}
          transferTargets={transferTargets}
          onTransferSelect={(toAccountId) => setSelection({ kind: "transfer", accountId: toAccountId, categoryId: null })}
          className="h-7 text-sm"
        />
        <CategoryTransferSelect
          groups={groups}
          transferTargets={transferTargets}
          value={selection}
          onChange={setSelection}
        />
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

"use client";

import { Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseMoneyInput } from "@/lib/currency";
import type { CategoryGroupOption, TransferTarget } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { createTransactionAction, createTransferAction } from "../actions";
import { CategoryTransferSelect, type CategorySelection } from "./category-transfer-select";
import { REGISTER_GRID } from "./grid";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const EMPTY_SELECTION: CategorySelection = { kind: "rta" };

export function AddTransactionRow({
  accountId,
  groups,
  transferTargets,
}: {
  accountId: number;
  groups: CategoryGroupOption[];
  transferTargets: TransferTarget[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(todayIso());
  const [payee, setPayee] = useState("");
  const [selection, setSelection] = useState<CategorySelection>(EMPTY_SELECTION);
  const [memo, setMemo] = useState("");
  const [outflow, setOutflow] = useState("");
  const [inflow, setInflow] = useState("");

  function reset() {
    setPayee("");
    setSelection(EMPTY_SELECTION);
    setMemo("");
    setOutflow("");
    setInflow("");
    setError(null);
  }

  function save() {
    if (!date) {
      setError("Date is required.");
      return;
    }
    let amount: number | null = null;
    if (outflow.trim() !== "") {
      const parsed = parseMoneyInput(outflow);
      amount = parsed == null ? null : -Math.abs(parsed);
    } else if (inflow.trim() !== "") {
      amount = parseMoneyInput(inflow);
    }
    if (amount == null || amount === 0) {
      setError("Enter an outflow or inflow amount.");
      return;
    }
    const needsLinkedCategory =
      selection.kind === "transfer" &&
      transferTargets.find((a) => a.id === selection.accountId)?.type === "tracking" &&
      selection.categoryId == null;
    if (needsLinkedCategory) {
      setError("Choose a budget category for this transfer.");
      return;
    }

    setError(null);
    startTransition(async () => {
      const result =
        selection.kind === "transfer"
          ? await createTransferAction({
              fromAccountId: accountId,
              toAccountId: selection.accountId,
              date,
              amount,
              memo,
              cleared: true,
              categoryId: selection.categoryId,
            })
          : await createTransactionAction({
              accountId,
              date,
              payee,
              memo,
              cleared: true,
              amount,
              categoryId: selection.kind === "category" ? selection.categoryId : null,
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
        <Input
          placeholder="Payee"
          value={payee}
          onChange={(e) => setPayee(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
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

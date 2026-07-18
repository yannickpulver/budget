"use client";

import { CircleCheck, Circle, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AccountType } from "@/lib/budget-math";
import { formatMoney, parseMoneyInput } from "@/lib/currency";
import type { AccountRef, CategoryGroupOption, RegisterRow } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { deleteTransactionAction, toggleClearedAction, updateTransactionAction } from "../actions";
import { CategorySelect } from "./category-select";
import { REGISTER_GRID } from "./grid";

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

interface AmountFields {
  outflow: string;
  inflow: string;
}

function amountToFields(amount: number): AmountFields {
  if (amount < 0) return { outflow: formatMoney(-amount), inflow: "" };
  if (amount > 0) return { outflow: "", inflow: formatMoney(amount) };
  return { outflow: "", inflow: "" };
}

function fieldsToAmount(fields: AmountFields): number | null {
  if (fields.outflow.trim() !== "") {
    const parsed = parseMoneyInput(fields.outflow);
    return parsed == null ? null : -Math.abs(parsed);
  }
  if (fields.inflow.trim() !== "") {
    const parsed = parseMoneyInput(fields.inflow);
    return parsed == null ? null : Math.abs(parsed);
  }
  return 0; // both empty is only valid while still editing; caller rejects 0 on submit
}

export function TransactionRow({
  row,
  accountId,
  accountType,
  groups,
  accountsById,
}: {
  row: RegisterRow;
  accountId: number;
  accountType: AccountType;
  groups: CategoryGroupOption[];
  accountsById: Map<number, AccountRef>;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [date, setDate] = useState(row.date);
  const [payee, setPayee] = useState(row.payee);
  const [categoryId, setCategoryId] = useState<number | null>(row.categoryId);
  const [memo, setMemo] = useState(row.memo);
  const [amountFields, setAmountFields] = useState<AmountFields>(() => amountToFields(row.amount));

  const isTransfer = row.transferAccountId != null;
  const otherAccount = row.transferAccountId != null ? accountsById.get(row.transferAccountId) : undefined;
  const linkedCategoryEditable = isTransfer && accountType !== "tracking" && otherAccount?.type === "tracking";

  const displayPayee = isTransfer ? `Transfer: ${row.transferAccountName ?? "?"}` : row.payee || "—";
  const displayCategory = row.categoryName ?? (isTransfer ? "—" : "Ready to Assign");

  function openEdit() {
    setDate(row.date);
    setPayee(row.payee);
    setCategoryId(row.categoryId);
    setMemo(row.memo);
    setAmountFields(amountToFields(row.amount));
    setError(null);
    setEditing(true);
  }

  function toggleCleared(e: React.MouseEvent) {
    e.stopPropagation();
    startTransition(() => toggleClearedAction(row.id, accountId, row.transferAccountId));
  }

  function save() {
    const amount = fieldsToAmount(amountFields);
    if (amount == null) {
      setError("Amount is not a valid number.");
      return;
    }
    if (amount === 0) {
      setError("Enter an outflow or inflow amount.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await updateTransactionAction(row.id, accountId, row.transferAccountId, {
        date,
        payee,
        categoryId: isTransfer ? (linkedCategoryEditable ? categoryId : null) : categoryId,
        memo,
        amount,
        cleared: row.cleared,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(false);
    });
  }

  function remove() {
    if (!confirm("Delete this transaction?")) return;
    startTransition(() => deleteTransactionAction(row.id, accountId, row.transferAccountId));
  }

  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={openEdit}
        onKeyDown={(e) => e.key === "Enter" && openEdit()}
        className={cn(
          REGISTER_GRID,
          "cursor-pointer px-2 py-1.5 text-sm hover:bg-muted/60",
          pending && "opacity-50"
        )}
      >
        <div className="text-muted-foreground tabular-nums">{formatDate(row.date)}</div>
        <div className="truncate">{displayPayee}</div>
        <div className="truncate text-muted-foreground">{displayCategory}</div>
        <div className="truncate text-muted-foreground">{row.memo}</div>
        <div className="text-right tabular-nums">
          {row.amount < 0 ? formatMoney(-row.amount) : ""}
        </div>
        <div className="text-right tabular-nums">{row.amount > 0 ? formatMoney(row.amount) : ""}</div>
        <button
          type="button"
          onClick={toggleCleared}
          aria-label={row.cleared ? "Mark uncleared" : "Mark cleared"}
          className="flex justify-center text-muted-foreground hover:text-foreground"
        >
          {row.cleared ? (
            <CircleCheck className="size-4 text-emerald-600" />
          ) : (
            <Circle className="size-4" />
          )}
        </button>
      </div>
    );
  }

  return (
    <div
      className="bg-muted/30 px-2 py-1.5"
      onKeyDown={(e) => {
        if (e.key === "Escape") setEditing(false);
      }}
    >
      <div className={cn(REGISTER_GRID, "gap-y-1.5")}>
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.currentTarget.value)}
          className="h-7 text-xs"
        />
        {isTransfer ? (
          <div className="truncate px-1 text-sm text-muted-foreground">{displayPayee}</div>
        ) : (
          <Input value={payee} onChange={(e) => setPayee(e.currentTarget.value)} className="h-7 text-sm" />
        )}
        {isTransfer ? (
          linkedCategoryEditable ? (
            <CategorySelect
              groups={groups}
              value={categoryId}
              onChange={setCategoryId}
              placeholder="Budget category"
              className="h-7 w-full min-w-0 text-sm"
            />
          ) : (
            <div className="px-1 text-sm text-muted-foreground">—</div>
          )
        ) : (
          <CategorySelect
            groups={groups}
            value={categoryId}
            onChange={setCategoryId}
            includeReadyToAssign
            className="h-7 w-full min-w-0 text-sm"
          />
        )}
        <Input value={memo} onChange={(e) => setMemo(e.currentTarget.value)} className="h-7 text-sm" />
        <Input
          inputMode="decimal"
          placeholder="Outflow"
          value={amountFields.outflow}
          onChange={(e) => setAmountFields({ outflow: e.currentTarget.value, inflow: "" })}
          onKeyDown={(e) => e.key === "Enter" && save()}
          className="h-7 text-right text-sm tabular-nums"
        />
        <Input
          inputMode="decimal"
          placeholder="Inflow"
          value={amountFields.inflow}
          onChange={(e) => setAmountFields({ outflow: "", inflow: e.currentTarget.value })}
          onKeyDown={(e) => e.key === "Enter" && save()}
          className="h-7 text-right text-sm tabular-nums"
        />
        <button
          type="button"
          onClick={toggleCleared}
          aria-label={row.cleared ? "Mark uncleared" : "Mark cleared"}
          className="flex justify-center text-muted-foreground hover:text-foreground"
        >
          {row.cleared ? (
            <CircleCheck className="size-4 text-emerald-600" />
          ) : (
            <Circle className="size-4" />
          )}
        </button>
      </div>

      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}

      <div className="mt-1.5 flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={remove} disabled={pending}>
          <Trash2 className="size-3.5" />
          Delete
        </Button>
        <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={pending}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={pending}>
          Save
        </Button>
      </div>
    </div>
  );
}

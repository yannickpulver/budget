"use client";

import { CircleCheck, Circle, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import type { AccountType } from "@/lib/budget-math";
import { formatMoney, parseMoneyInput } from "@/lib/currency";
import type { AccountRef, CategoryGroupOption, RegisterRow } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { deleteTransactionAction, toggleClearedAction, updateTransactionAction } from "../actions";
import { CategorySelect } from "./category-select";
import { REGISTER_GRID } from "./grid";

/**
 * Shared look for always-editable register cells: invisible border/background
 * at rest, a subtle hover fill, and a visible focus ring — no padding or
 * border-width changes between states, so nothing shifts when you hover or
 * focus into a cell.
 */
const CELL_FIELD =
  "h-7 rounded-md border border-transparent bg-transparent px-1.5 shadow-none transition-colors hover:bg-muted focus-visible:bg-background focus-visible:border-ring";

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
  return 0; // both empty — caller rejects 0 on commit
}

/** Snapshot of everything `updateTransactionAction` persists, used to detect no-op commits. */
interface Committed {
  date: string;
  payee: string;
  categoryId: number | null;
  memo: string;
  amount: number;
}

type FieldName = "date" | "payee" | "category" | "memo" | "outflow" | "inflow";

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
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [date, setDate] = useState(row.date);
  const [payee, setPayee] = useState(row.payee);
  const [categoryId, setCategoryId] = useState<number | null>(row.categoryId);
  const [memo, setMemo] = useState(row.memo);
  const [amountFields, setAmountFields] = useState<AmountFields>(() => amountToFields(row.amount));

  // Tracks which field currently has focus so external row updates (e.g. a
  // save landing, or the cleared toggle) don't clobber an in-progress edit —
  // fields that aren't focused stay in sync with the server-confirmed row.
  const focusedField = useRef<FieldName | null>(null);
  // Escape reverts a field's local state via `setState`, which doesn't take
  // effect until the next render — but the `blur()` we trigger right after
  // fires synchronously, so `onBlur`'s `commit()` would otherwise still see
  // the pre-revert value and save it. This flag makes that one blur a no-op.
  const skipNextCommit = useRef(false);
  // Last-known-persisted values, used to detect no-op commits and to power
  // Escape-to-revert without waiting on a server round trip.
  const committed = useRef<Committed>({
    date: row.date,
    payee: row.payee,
    categoryId: row.categoryId,
    memo: row.memo,
    amount: row.amount,
  });

  useEffect(() => {
    committed.current = {
      date: row.date,
      payee: row.payee,
      categoryId: row.categoryId,
      memo: row.memo,
      amount: row.amount,
    };
  }, [row.date, row.payee, row.categoryId, row.memo, row.amount]);

  useEffect(() => {
    if (focusedField.current !== "date") setDate(row.date);
  }, [row.date]);
  useEffect(() => {
    if (focusedField.current !== "payee") setPayee(row.payee);
  }, [row.payee]);
  useEffect(() => {
    if (focusedField.current !== "category") setCategoryId(row.categoryId);
  }, [row.categoryId]);
  useEffect(() => {
    if (focusedField.current !== "memo") setMemo(row.memo);
  }, [row.memo]);
  useEffect(() => {
    if (focusedField.current !== "outflow" && focusedField.current !== "inflow") {
      setAmountFields(amountToFields(row.amount));
    }
  }, [row.amount]);

  const isTransfer = row.transferAccountId != null;
  const otherAccount = row.transferAccountId != null ? accountsById.get(row.transferAccountId) : undefined;
  const linkedCategoryEditable = isTransfer && accountType !== "tracking" && otherAccount?.type === "tracking";

  const displayPayee = isTransfer ? `Transfer: ${row.transferAccountName ?? "?"}` : row.payee;

  function toggleCleared(e: React.MouseEvent) {
    e.stopPropagation();
    startTransition(() => toggleClearedAction(row.id, accountId, row.transferAccountId));
  }

  function remove() {
    if (!confirm("Delete this transaction?")) return;
    startTransition(() => deleteTransactionAction(row.id, accountId, row.transferAccountId));
  }

  /**
   * Commits the whole row (the update action always writes every field) if
   * anything differs from the last-saved snapshot. `categoryOverride` lets
   * the category select commit synchronously with its new value, since
   * `setCategoryId` hasn't re-rendered yet when `onValueChange` fires.
   */
  function commit(categoryOverride?: { categoryId: number | null }) {
    const amount = fieldsToAmount(amountFields);
    if (amount == null) {
      setError("Amount is not a valid number.");
      return;
    }
    if (amount === 0) {
      setError("Enter an outflow or inflow amount.");
      return;
    }
    if (!date) {
      setError("Date is required.");
      return;
    }

    const rawCategoryId = categoryOverride ? categoryOverride.categoryId : categoryId;
    const nextCategoryId = isTransfer ? (linkedCategoryEditable ? rawCategoryId : null) : rawCategoryId;
    const next: Committed = { date, payee, categoryId: nextCategoryId, memo, amount };
    const prev = committed.current;
    const unchanged =
      next.date === prev.date &&
      next.payee === prev.payee &&
      next.categoryId === prev.categoryId &&
      next.memo === prev.memo &&
      next.amount === prev.amount;
    if (unchanged) {
      setError(null);
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await updateTransactionAction(row.id, accountId, row.transferAccountId, {
        ...next,
        cleared: row.cleared,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      committed.current = next;
    });
  }

  function revertDate() {
    setDate(committed.current.date);
  }
  function revertPayee() {
    setPayee(committed.current.payee);
  }
  function revertMemo() {
    setMemo(committed.current.memo);
  }
  function revertAmount() {
    setAmountFields(amountToFields(committed.current.amount));
    setError(null);
  }

  function handleCategoryChange(next: number | null) {
    setCategoryId(next);
    commit({ categoryId: next });
  }

  return (
    <div className={cn(REGISTER_GRID, "group px-2 py-1.5 text-sm", pending && "opacity-50")}>
      <Input
        type="date"
        value={date}
        onChange={(e) => setDate(e.currentTarget.value)}
        onFocus={() => (focusedField.current = "date")}
        onBlur={() => {
          focusedField.current = null;
          if (skipNextCommit.current) {
            skipNextCommit.current = false;
            return;
          }
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            skipNextCommit.current = true;
            revertDate();
            e.currentTarget.blur();
          }
        }}
        className={cn(CELL_FIELD, "text-xs text-muted-foreground tabular-nums")}
        aria-label="Date"
      />
      {isTransfer ? (
        <div className="truncate px-1.5 text-sm">{displayPayee}</div>
      ) : (
        <Input
          value={payee}
          onChange={(e) => setPayee(e.currentTarget.value)}
          onFocus={() => (focusedField.current = "payee")}
          onBlur={() => {
            focusedField.current = null;
            if (skipNextCommit.current) {
              skipNextCommit.current = false;
              return;
            }
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              skipNextCommit.current = true;
              revertPayee();
              e.currentTarget.blur();
            }
          }}
          placeholder="Payee"
          className={cn(CELL_FIELD, "text-sm")}
          aria-label="Payee"
        />
      )}
      {isTransfer && !linkedCategoryEditable ? (
        <div className="truncate px-1.5 text-sm text-muted-foreground">—</div>
      ) : (
        <CategorySelect
          groups={groups}
          value={categoryId}
          onChange={handleCategoryChange}
          includeReadyToAssign={!isTransfer}
          placeholder={isTransfer ? "Budget category" : "Category"}
          className={cn(CELL_FIELD, "w-full min-w-0 justify-start text-sm text-muted-foreground")}
        />
      )}
      <Input
        value={memo}
        onChange={(e) => setMemo(e.currentTarget.value)}
        onFocus={() => (focusedField.current = "memo")}
        onBlur={() => {
          focusedField.current = null;
          if (skipNextCommit.current) {
            skipNextCommit.current = false;
            return;
          }
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            skipNextCommit.current = true;
            revertMemo();
            e.currentTarget.blur();
          }
        }}
        placeholder="Memo"
        className={cn(CELL_FIELD, "text-sm text-muted-foreground")}
        aria-label="Memo"
      />
      <Input
        inputMode="decimal"
        placeholder="Outflow"
        value={amountFields.outflow}
        onChange={(e) => setAmountFields({ outflow: e.currentTarget.value, inflow: "" })}
        onFocus={() => (focusedField.current = "outflow")}
        onBlur={() => {
          focusedField.current = null;
          if (skipNextCommit.current) {
            skipNextCommit.current = false;
            return;
          }
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            skipNextCommit.current = true;
            revertAmount();
            e.currentTarget.blur();
          }
        }}
        className={cn(CELL_FIELD, "text-right text-sm tabular-nums")}
        aria-label="Outflow"
      />
      <Input
        inputMode="decimal"
        placeholder="Inflow"
        value={amountFields.inflow}
        onChange={(e) => setAmountFields({ outflow: "", inflow: e.currentTarget.value })}
        onFocus={() => (focusedField.current = "inflow")}
        onBlur={() => {
          focusedField.current = null;
          if (skipNextCommit.current) {
            skipNextCommit.current = false;
            return;
          }
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            skipNextCommit.current = true;
            revertAmount();
            e.currentTarget.blur();
          }
        }}
        className={cn(CELL_FIELD, "text-right text-sm tabular-nums")}
        aria-label="Inflow"
      />
      <div className="flex items-center justify-center gap-1">
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
        <button
          type="button"
          onClick={remove}
          disabled={pending}
          aria-label="Delete transaction"
          className="flex justify-center text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {error && <p className="col-span-full mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

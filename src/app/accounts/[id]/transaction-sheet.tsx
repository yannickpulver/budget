"use client";

import { ArrowLeftRight, Circle, CircleCheck } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PayeeInput } from "@/components/payee-input";
import type { AccountType } from "@/lib/budget-math";
import type { CategoryGroupOption, RegisterRow, TransferTarget } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { convertToTransferAction, deleteTransactionAction } from "../actions";
import { CategorySelect } from "./category-select";
import {
  amountToFields,
  createTransaction,
  isUnchanged,
  saveTransaction,
  validateAmountAndDate,
  type AmountFields,
  type Committed,
} from "./transaction-fields";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface SharedProps {
  accountId: number;
  groups: CategoryGroupOption[];
  transferTargets: TransferTarget[];
  payeeSuggestions: string[];
}

/**
 * The below-`md` editor for a register row — the seven-column desktop grid
 * doesn't fit a phone, so tapping a row (or the floating "+") opens this
 * bottom sheet with the same fields stacked, writing through the same
 * validation and the same server actions the inline cells use.
 *
 * `row` present = edit an existing transaction, absent = create a new one.
 * The form lives in a child component so its state is rebuilt from scratch
 * every time the sheet opens (base-ui unmounts a closed popup).
 */
export function TransactionSheet({
  open,
  onOpenChange,
  row,
  accountType,
  otherAccountType,
  defaultCategoryId,
  ...shared
}: SharedProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row?: RegisterRow;
  /** The register's own account type — decides whether a transfer leg can carry a category. */
  accountType?: AccountType;
  /** Type of the counterpart account on a transfer row. */
  otherAccountType?: AccountType;
  /** Create mode: giftcard accounts default new spend to their own category. */
  defaultCategoryId?: number | null;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="max-h-[90dvh] gap-0 overflow-y-auto rounded-t-xl p-0"
      >
        <SheetHeader className="border-b border-border pb-3">
          <SheetTitle>{row ? "Edit transaction" : "New transaction"}</SheetTitle>
        </SheetHeader>
        <TransactionForm
          {...shared}
          row={row}
          accountType={accountType}
          otherAccountType={otherAccountType}
          defaultCategoryId={defaultCategoryId}
          onDone={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  );
}

function TransactionForm({
  accountId,
  groups,
  transferTargets,
  payeeSuggestions,
  row,
  accountType,
  otherAccountType,
  defaultCategoryId,
  onDone,
}: SharedProps & {
  row?: RegisterRow;
  accountType?: AccountType;
  otherAccountType?: AccountType;
  defaultCategoryId?: number | null;
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [date, setDate] = useState(row?.date ?? todayIso());
  const [payee, setPayee] = useState(row?.payee ?? "");
  const [memo, setMemo] = useState(row?.memo ?? "");
  const [cleared, setCleared] = useState(row?.cleared ?? true);
  const [amountFields, setAmountFields] = useState<AmountFields>(() =>
    row ? amountToFields(row.amount) : { outflow: "", inflow: "" }
  );
  const [categoryId, setCategoryId] = useState<number | null>(
    row ? row.categoryId : (defaultCategoryId ?? null)
  );
  /** Create mode: set by picking a "Transfer: <Account>" payee entry. */
  const [transferTo, setTransferTo] = useState<number | null>(null);

  const isTransfer = row ? row.transferAccountId != null : transferTo != null;
  // Only the on-budget leg of a transfer to/from a tracking account carries a
  // budget category — same rule the desktop row applies.
  const transferTarget = transferTo == null ? undefined : transferTargets.find((a) => a.id === transferTo);
  const linkedCategoryEditable = row
    ? row.transferAccountId != null && accountType !== "tracking" && otherAccountType === "tracking"
    : transferTarget?.type === "tracking";

  function save() {
    const validated = validateAmountAndDate(amountFields, date);
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    setError(null);

    if (!row) {
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
        onDone();
      });
      return;
    }

    const next: Committed = {
      date,
      payee: isTransfer ? row.payee : payee,
      categoryId: isTransfer ? (linkedCategoryEditable ? categoryId : null) : categoryId,
      memo,
      amount: validated.amount,
    };
    const prev: Committed = {
      date: row.date,
      payee: row.payee,
      categoryId: row.categoryId,
      memo: row.memo,
      amount: row.amount,
    };
    if (isUnchanged(next, prev) && cleared === row.cleared) {
      onDone();
      return;
    }
    startTransition(async () => {
      const result = await saveTransaction(row.id, accountId, row.transferAccountId, next, cleared);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone();
    });
  }

  function remove() {
    if (!row) return;
    if (!confirm("Delete this transaction?")) return;
    startTransition(async () => {
      await deleteTransactionAction(row.id, accountId, row.transferAccountId);
      onDone();
    });
  }

  /** Picking a "Transfer: <Account>" payee converts (or retargets) the row, exactly as on desktop. */
  function convertToTransfer(toAccountId: number) {
    if (!row) {
      const target = transferTargets.find((a) => a.id === toAccountId);
      setTransferTo(toAccountId);
      setPayee(`Transfer: ${target?.name ?? "?"}`);
      if (target?.type !== "tracking") setCategoryId(null);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await convertToTransferAction(
        row.id,
        accountId,
        toAccountId,
        row.transferAccountId
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone();
    });
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <Field label="Date">
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          className="tabular-nums"
          aria-label="Date"
        />
      </Field>

      <Field label={row && isTransfer ? "Transfer" : "Payee"}>
        {row && isTransfer ? (
          <div className="flex h-8 items-center gap-1.5 rounded-lg border border-input px-2.5 text-sm text-muted-foreground">
            <ArrowLeftRight className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{row?.transferAccountName ?? "?"}</span>
          </div>
        ) : (
          <PayeeInput
            suggestions={payeeSuggestions}
            value={payee}
            // Typing over a "Transfer: <Account>" payee makes this a plain
            // transaction again, exactly as it does on an existing row.
            onValueChange={(next) => {
              setPayee(next);
              if (!row) setTransferTo(null);
            }}
            transferTargets={transferTargets}
            onTransferSelect={convertToTransfer}
            onEnter={() => save()}
            placeholder="Payee"
            aria-label="Payee"
          />
        )}
      </Field>

      {/* A transfer between two on-budget accounts carries no category at all. */}
      {(!isTransfer || linkedCategoryEditable) && (
        <Field label={isTransfer ? "Budget category" : "Category"}>
          <CategorySelect
            groups={groups}
            value={categoryId}
            onChange={setCategoryId}
            includeReadyToAssign={!isTransfer}
            placeholder={isTransfer ? "Budget category" : "Category"}
            className="w-full min-w-0 justify-start"
          />
        </Field>
      )}

      <Field label="Memo">
        <Input
          value={memo}
          onChange={(e) => setMemo(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="Memo"
          aria-label="Memo"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Outflow">
          <Input
            inputMode="decimal"
            placeholder="0.00"
            value={amountFields.outflow}
            onChange={(e) => setAmountFields({ outflow: e.currentTarget.value, inflow: "" })}
            onKeyDown={(e) => e.key === "Enter" && save()}
            className="text-right tabular-nums"
            aria-label="Outflow"
          />
        </Field>
        <Field label="Inflow">
          <Input
            inputMode="decimal"
            placeholder="0.00"
            value={amountFields.inflow}
            onChange={(e) => setAmountFields({ outflow: "", inflow: e.currentTarget.value })}
            onKeyDown={(e) => e.key === "Enter" && save()}
            className="text-right tabular-nums"
            aria-label="Inflow"
          />
        </Field>
      </div>

      <button
        type="button"
        onClick={() => setCleared((c) => !c)}
        aria-pressed={cleared}
        className="flex items-center gap-2 self-start rounded-md py-1 text-sm"
      >
        {cleared ? (
          <CircleCheck className="size-4 text-emerald-600" />
        ) : (
          <Circle className="size-4 text-muted-foreground" />
        )}
        {cleared ? "Cleared" : "Uncleared"}
      </button>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className={cn("pb-safe flex gap-2 pt-1", pending && "opacity-50")}>
        {row && (
          <Button variant="destructive" onClick={remove} disabled={pending}>
            Delete
          </Button>
        )}
        <Button variant="outline" onClick={onDone} disabled={pending} className="ml-auto">
          Cancel
        </Button>
        <Button onClick={save} disabled={pending}>
          Save
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  // A plain div, not a <label>: several of the controls in here are buttons
  // (the category select, the payee combobox) and a wrapping label would
  // forward the click into a second toggle.
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground uppercase">{label}</span>
      {children}
    </div>
  );
}

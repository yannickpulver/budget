"use client";

import { useRef, useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { evaluateMoneyExpression, formatMoney } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { setCashAction } from "./holdings-actions";
import { HOLDINGS_GRID } from "./holdings-grid";

/**
 * Uninvested cash on the account, as the last row of the holdings list.
 * Click the amount to edit it; Enter or blur saves, Escape cancels.
 */
export function CashRow({ accountId, cash }: { accountId: number; cash: number }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Enter/Escape unmount the input, which fires a blur; this stops a second save.
  const done = useRef(false);

  function openEdit() {
    setValue(formatMoney(cash));
    setError(null);
    done.current = false;
    setEditing(true);
  }

  function cancel() {
    done.current = true;
    setEditing(false);
  }

  function save() {
    if (done.current) return;
    const parsed = evaluateMoneyExpression(value);
    if (parsed == null) {
      setError("Not a valid amount.");
      return;
    }
    done.current = true;
    setEditing(false);
    if (parsed === cash) return;
    startTransition(async () => {
      const result = await setCashAction(accountId, parsed);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    // Mobile right padding = holding rows' px-3 + gap + chevron, so the amounts line up.
    <div className={cn("px-2 py-1.5 text-sm max-md:py-2 max-md:pr-[2.125rem] max-md:pl-3", pending && "opacity-50")}>
      <div className={HOLDINGS_GRID}>
        <div className="font-medium">Cash</div>
        <div className="hidden text-muted-foreground md:block">Not invested</div>
        <div className="hidden md:block" />
        <div className="hidden md:block" />
        {editing ? (
          <Input
            autoFocus
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") cancel();
            }}
            className="h-8 w-28 justify-self-end text-right text-sm tabular-nums md:h-7 md:w-full"
            aria-label="Cash"
          />
        ) : (
          <button
            type="button"
            onClick={openEdit}
            className="-mr-1 justify-self-end rounded px-1 text-right font-medium tabular-nums hover:bg-muted/60"
          >
            {formatMoney(cash)}
          </button>
        )}
        <div className="hidden md:block" />
      </div>
      {error && <p className="mt-1 text-right text-xs text-destructive">{error}</p>}
    </div>
  );
}

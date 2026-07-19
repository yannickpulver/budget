"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { evaluateMoneyExpression, formatMoney } from "@/lib/currency";
import { setAssigned } from "../actions";

export function AssignCell({
  month,
  categoryId,
  assigned,
}: {
  month: string;
  categoryId: number;
  assigned: number;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [pending, startTransition] = useTransition();

  function open() {
    setValue(assigned === 0 ? "" : formatMoney(assigned));
    setEditing(true);
  }

  function commitAndClose() {
    setEditing(false);
    const parsed = value.trim() === "" ? 0 : evaluateMoneyExpression(value);
    const next = parsed == null ? assigned : parsed;
    if (next === assigned) return;
    startTransition(() => setAssigned(month, categoryId, next));
  }

  if (editing) {
    return (
      <input
        autoFocus
        inputMode="decimal"
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.currentTarget.value)}
        onBlur={commitAndClose}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitAndClose();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        className="h-7 w-full rounded-md border border-ring bg-background px-2 text-right text-sm tabular-nums outline-none ring-2 ring-ring/40"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      className={cn(
        "h-7 w-full rounded-md px-2 text-right text-sm tabular-nums hover:bg-muted",
        assigned === 0 && "text-muted-foreground",
        pending && "opacity-50"
      )}
    >
      {formatMoney(assigned)}
    </button>
  );
}

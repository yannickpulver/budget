"use client";

import { useRef, useState, useTransition } from "react";
import { Check, RotateCcw, Target } from "lucide-react";
import { cn } from "@/lib/utils";
import { evaluateMoneyExpression, formatCurrency, formatMoney } from "@/lib/currency";
import type { TargetType } from "@/lib/budget-math";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { closeCategory, fundToGoal, resetGoalFunding, setBalanceTarget, setMonthlyTarget } from "../actions";

interface GoalControlProps {
  month: string;
  categoryId: number;
  monthlyTarget: number | null;
  targetType: TargetType;
  targetDate: string | null;
  available: number;
  currency: string;
  goalMet: boolean;
  /** Needs funding this month — shows the "to go" amount and the Fund button. */
  underfunded: boolean;
  remaining: number;
  /** Goal met via the "Fund" button this month — the ✓ becomes a reset toggle. */
  funded: boolean;
  /** Closing a category is only offered from the current month (hiding is global). */
  isCurrentMonth: boolean;
}

export function GoalControl({
  month,
  categoryId,
  monthlyTarget,
  targetType,
  targetDate,
  available,
  currency,
  goalMet,
  underfunded,
  remaining,
  funded,
  isCurrentMonth,
}: GoalControlProps) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<TargetType>(targetType);
  const [value, setValue] = useState("");
  const [date, setDate] = useState("");
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function onOpenChange(next: boolean) {
    if (next) {
      setType(targetType);
      setValue(monthlyTarget == null ? "" : formatMoney(monthlyTarget));
      setDate(targetDate ?? "");
    }
    setOpen(next);
  }

  function save() {
    const parsed = evaluateMoneyExpression(value);
    if (parsed == null) return;
    setOpen(false);
    startTransition(() =>
      type === "balance"
        ? setBalanceTarget(categoryId, parsed, date || null)
        : setMonthlyTarget(categoryId, parsed)
    );
  }

  function clear() {
    setOpen(false);
    startTransition(() => setMonthlyTarget(categoryId, null));
  }

  function fund() {
    startTransition(() => fundToGoal(month, categoryId));
  }

  function reset() {
    startTransition(() => resetGoalFunding(month, categoryId));
  }

  function close() {
    if (
      available > 0 &&
      !confirm(
        `Release ${formatCurrency(available, currency)} back to Ready to Assign and hide this category?`
      )
    ) {
      return;
    }
    setOpen(false);
    startTransition(() => closeCategory(month, categoryId));
  }

  const target = monthlyTarget ?? 0;
  const progress = target > 0 ? Math.max(0, Math.min(100, Math.round((available / target) * 100))) : 0;
  const status = !goalMet
    ? underfunded
      ? "behind"
      : "on track"
    : available >= target
      ? "reached"
      : "funded";

  return (
    <div className={cn("flex items-center gap-1.5", pending && "opacity-50")}>
      {underfunded && (
        <>
          <span className="text-xs text-amber-600 tabular-nums">
            {formatMoney(remaining)} to go
          </span>
          <Button size="xs" variant="outline" onClick={fund} disabled={pending}>
            Fund
          </Button>
        </>
      )}
      {monthlyTarget != null && goalMet && funded && (
        <button
          type="button"
          onClick={reset}
          disabled={pending}
          aria-label="Funded this month — click to reset"
          title="Funded this month — click to reset"
          className="group flex size-4 items-center justify-center text-emerald-600 hover:text-amber-600"
        >
          <Check className="size-3.5 group-hover:hidden" />
          <RotateCcw className="hidden size-3 group-hover:block" />
        </button>
      )}
      {monthlyTarget != null && goalMet && !funded && (
        <Check className="size-3.5 text-emerald-600" aria-label="Goal met" />
      )}

      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          aria-label="Edit goal"
          className={cn(
            "flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
            monthlyTarget != null && "text-foreground"
          )}
        >
          <Target className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60" initialFocus={inputRef}>
          <PopoverHeader>
            <PopoverTitle>Goal</PopoverTitle>
          </PopoverHeader>

          <div className="flex rounded-md border border-border p-0.5">
            {(["monthly", "balance"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={cn(
                  "flex-1 rounded px-2 py-1 text-xs font-medium transition-colors",
                  type === t
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t === "monthly" ? "Monthly" : "Savings target"}
              </button>
            ))}
          </div>

          <Input
            ref={inputRef}
            inputMode="decimal"
            placeholder="0.00"
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
            className="text-right tabular-nums"
          />

          {type === "balance" && (
            <>
              <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                By
                <Input
                  type="month"
                  value={date}
                  onChange={(e) => setDate(e.currentTarget.value)}
                  className="h-7 w-36 tabular-nums"
                />
              </label>
              {monthlyTarget != null && targetType === "balance" && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
                    <span>
                      {formatMoney(available)} / {formatMoney(target)}
                    </span>
                    <span className={cn(underfunded ? "text-amber-600" : "text-emerald-600")}>
                      {status}
                    </span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              )}
            </>
          )}

          <div className="flex justify-between gap-2">
            {monthlyTarget != null ? (
              <Button size="sm" variant="ghost" onClick={clear}>
                Clear
              </Button>
            ) : (
              <span />
            )}
            <Button size="sm" onClick={save}>
              Save
            </Button>
          </div>

          <button
            type="button"
            onClick={close}
            disabled={pending || !isCurrentMonth || available < 0}
            title={
              !isCurrentMonth
                ? "Close from the current month"
                : available < 0
                  ? "Cover the overspend before closing"
                  : undefined
            }
            className="border-t border-border pt-2 text-left text-xs text-muted-foreground hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
          >
            Close category
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

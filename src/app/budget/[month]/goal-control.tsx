"use client";

import { useRef, useState, useTransition } from "react";
import { Check, Target } from "lucide-react";
import { cn } from "@/lib/utils";
import { evaluateMoneyExpression, formatMoney } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { fundToGoal, setMonthlyTarget } from "../actions";

interface GoalControlProps {
  month: string;
  categoryId: number;
  monthlyTarget: number | null;
  goalMet: boolean;
  remaining: number;
}

export function GoalControl({
  month,
  categoryId,
  monthlyTarget,
  goalMet,
  remaining,
}: GoalControlProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function onOpenChange(next: boolean) {
    if (next) setValue(monthlyTarget == null ? "" : formatMoney(monthlyTarget));
    setOpen(next);
  }

  function save() {
    const parsed = evaluateMoneyExpression(value);
    setOpen(false);
    startTransition(() => setMonthlyTarget(categoryId, parsed));
  }

  function clear() {
    setOpen(false);
    startTransition(() => setMonthlyTarget(categoryId, null));
  }

  function fund() {
    startTransition(() => fundToGoal(month, categoryId));
  }

  return (
    <div className={cn("flex items-center gap-1.5", pending && "opacity-50")}>
      {monthlyTarget != null && !goalMet && (
        <>
          <span className="text-xs text-amber-600 tabular-nums">
            {formatMoney(remaining)} to go
          </span>
          <Button size="xs" variant="outline" onClick={fund} disabled={pending}>
            Fund
          </Button>
        </>
      )}
      {monthlyTarget != null && goalMet && (
        <Check className="size-3.5 text-emerald-600" aria-label="Goal met" />
      )}

      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          aria-label="Edit monthly target"
          className={cn(
            "flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
            monthlyTarget != null && "text-foreground"
          )}
        >
          <Target className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56" initialFocus={inputRef}>
          <PopoverHeader>
            <PopoverTitle>Monthly target</PopoverTitle>
          </PopoverHeader>
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
        </PopoverContent>
      </Popover>
    </div>
  );
}

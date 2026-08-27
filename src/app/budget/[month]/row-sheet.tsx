"use client";

import { ChevronRight } from "lucide-react";
import { useState, useTransition } from "react";
import { hideCategoryFromMonth } from "../actions";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * The below-`md` face of a budget row. The four dense desktop columns don't
 * fit a phone, so the row shows name + Available and everything else moves
 * into a bottom sheet — which renders the *same* cell components the desktop
 * row does (passed in as nodes), so there is exactly one implementation of
 * assigning, moving money and editing a goal.
 */
export function BudgetRowSheet({
  name,
  hint,
  remaining,
  underfunded,
  assignCell,
  activityCell,
  availablePill,
  goalControl,
  month,
  categoryId,
}: {
  name: string;
  /** Muted secondary line, e.g. the 6-month average spend. */
  hint?: string;
  /** "x to go" copy when the goal is underfunded this month. */
  remaining?: string;
  underfunded: boolean;
  assignCell: React.ReactNode;
  activityCell: React.ReactNode;
  availablePill: React.ReactNode;
  goalControl: React.ReactNode;
  month: string;
  categoryId: number;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function hide() {
    setOpen(false);
    startTransition(() => hideCategoryFromMonth(month, categoryId));
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="-mx-1 flex w-full min-w-0 items-center justify-between gap-1 rounded-md px-1 py-1.5 text-left active:bg-muted md:hidden"
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm">{name}</span>
          {(hint || (underfunded && remaining)) && (
            <span className="flex min-w-0 items-center gap-2 text-xs tabular-nums">
              {hint && <span className="truncate text-muted-foreground/60">{hint}</span>}
              {underfunded && remaining && <span className="text-amber-600">{remaining} to go</span>}
            </span>
          )}
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" showCloseButton={false} className="max-h-[85dvh] gap-0 overflow-y-auto rounded-t-xl p-0">
          <SheetHeader className="border-b border-border pb-3">
            <SheetTitle className="truncate">{name}</SheetTitle>
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
          </SheetHeader>

          <div className="flex flex-col divide-y divide-border/60 px-4">
            <Field label="Available">
              <div className="flex justify-end">{availablePill}</div>
            </Field>
            <Field label="Assigned">{assignCell}</Field>
            <Field label="Activity">{activityCell}</Field>
            <Field label="Goal">
              <div className="flex justify-end">{goalControl}</div>
            </Field>
          </div>

          <div className="flex flex-col gap-2 px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <Button variant="outline" className="w-full" onClick={() => setOpen(false)}>
              Done
            </Button>
            <button
              type="button"
              onClick={hide}
              disabled={pending}
              className="text-center text-xs text-muted-foreground hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
            >
              Hide from this month
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3 py-2", className)}>
      <span className="text-xs font-medium text-muted-foreground uppercase">{label}</span>
      <div className="w-40 min-w-0">{children}</div>
    </div>
  );
}

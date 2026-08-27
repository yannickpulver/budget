"use client";

import { Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { parseQuantityInput } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { HoldingFields } from "./holding-row";
import { createHoldingAction } from "./holdings-actions";
import { HOLDINGS_GRID } from "./holdings-grid";

export function AddHoldingRow({ accountId }: { accountId: number }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");

  function reset() {
    setSymbol("");
    setName("");
    setQuantity("");
    setError(null);
  }

  function save() {
    const trimmedSymbol = symbol.trim();
    if (!trimmedSymbol) {
      setError("Symbol is required.");
      return;
    }
    const parsedQuantity = parseQuantityInput(quantity);
    if (parsedQuantity == null) {
      setError("Enter a quantity greater than zero.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createHoldingAction(accountId, { symbol: trimmedSymbol, name, quantity: parsedQuantity });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      reset();
      setSheetOpen(false);
    });
  }

  const fields = (stacked: boolean) => (
    <HoldingFields
      symbol={symbol}
      name={name}
      quantity={quantity}
      onSymbol={setSymbol}
      onName={setName}
      onQuantity={setQuantity}
      onEnter={save}
      stacked={stacked}
      placeholders
    />
  );

  return (
    <>
      {/* Desktop: inline add row. */}
      <div className="hidden bg-background px-2 py-1.5 md:block">
        <div className={cn(HOLDINGS_GRID, "gap-y-1.5")}>
          {fields(false)}
          <div />
          <div />
          <Button size="icon-sm" variant="outline" onClick={save} disabled={pending} aria-label="Add holding">
            <Plus className="size-3.5" />
          </Button>
        </div>
        {error && !sheetOpen && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
      </div>

      {/* Mobile: the same three fields in a sheet. */}
      <button
        type="button"
        onClick={() => {
          reset();
          setSheetOpen(true);
        }}
        className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left text-sm font-medium text-muted-foreground active:bg-muted md:hidden"
      >
        <Plus className="size-4" />
        Add holding
      </button>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[90dvh] gap-0 overflow-y-auto rounded-t-xl p-0"
        >
          <SheetHeader className="border-b border-border pb-3">
            <SheetTitle>New holding</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3 p-4">
            {fields(true)}
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className={cn("pb-safe flex justify-end gap-2 pt-1", pending && "opacity-50")}>
              <Button variant="outline" onClick={() => setSheetOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={save} disabled={pending}>
                Add
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

"use client";

import { Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseQuantityInput } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { createHoldingAction } from "./holdings-actions";
import { HOLDINGS_GRID } from "./holdings-grid";

export function AddHoldingRow({ accountId }: { accountId: number }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
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
    });
  }

  return (
    <div className="bg-background px-2 py-1.5">
      <div className={cn(HOLDINGS_GRID, "gap-y-1.5")}>
        <Input
          placeholder="Symbol (VWRL.SW)"
          value={symbol}
          onChange={(e) => setSymbol(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          className="h-7 text-sm"
        />
        <Input
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          className="h-7 text-sm"
        />
        <Input
          inputMode="decimal"
          placeholder="Quantity"
          value={quantity}
          onChange={(e) => setQuantity(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          className="h-7 text-right text-sm tabular-nums"
        />
        <div />
        <div />
        <Button size="icon-sm" variant="outline" onClick={save} disabled={pending} aria-label="Add holding">
          <Plus className="size-3.5" />
        </Button>
      </div>
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
  );
}

"use client";

import { AlertTriangle, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney, formatQuantity, parseQuantityInput } from "@/lib/currency";
import type { HoldingRow as HoldingRowData } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { deleteHoldingAction, updateHoldingAction } from "./holdings-actions";
import { HOLDINGS_GRID } from "./holdings-grid";

function statusHint(holding: HoldingRowData): string | null {
  if (holding.fetchError) return `Price fetch failed: ${holding.fetchError}`;
  if (holding.priceRappen == null) return "No price fetched yet.";
  if (holding.stale) return `Price is stale (last updated ${new Date(holding.fetchedAt!).toLocaleString()}).`;
  return null;
}

export function HoldingRow({ holding, accountId }: { holding: HoldingRowData; accountId: number }) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [symbol, setSymbol] = useState(holding.symbol);
  const [name, setName] = useState(holding.name);
  const [quantity, setQuantity] = useState(String(holding.quantity));

  function openEdit() {
    setSymbol(holding.symbol);
    setName(holding.name);
    setQuantity(String(holding.quantity));
    setError(null);
    setEditing(true);
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
      const result = await updateHoldingAction(holding.id, accountId, {
        symbol: trimmedSymbol,
        name,
        quantity: parsedQuantity,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(false);
    });
  }

  function remove() {
    if (!confirm(`Delete holding "${holding.symbol}"?`)) return;
    startTransition(async () => {
      await deleteHoldingAction(holding.id, accountId);
    });
  }

  const hint = statusHint(holding);
  const fxNote =
    holding.fxRate != null && holding.currency ? `≈ converted from ${holding.currency} @ ${holding.fxRate.toFixed(4)}` : null;

  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={openEdit}
        onKeyDown={(e) => e.key === "Enter" && openEdit()}
        className={cn(HOLDINGS_GRID, "cursor-pointer px-2 py-1.5 text-sm hover:bg-muted/60", pending && "opacity-50")}
      >
        <div className="truncate font-medium">{holding.symbol}</div>
        <div className="truncate text-muted-foreground">{holding.name || "—"}</div>
        <div className="text-right tabular-nums">{formatQuantity(holding.quantity)}</div>
        <div className="text-right tabular-nums" title={fxNote ?? undefined}>
          {holding.priceRappen != null ? formatMoney(holding.priceRappen) : "—"}
          {fxNote && <span className="ml-1 text-[10px] text-muted-foreground">≈</span>}
        </div>
        <div className="text-right font-medium tabular-nums">
          {holding.valueRappen != null ? formatMoney(holding.valueRappen) : "—"}
        </div>
        <div className="flex justify-center">
          {hint && (
            <span title={hint}>
              <AlertTriangle
                className={cn("size-3.5", holding.fetchError ? "text-amber-600" : "text-muted-foreground")}
              />
            </span>
          )}
        </div>
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
      <div className={cn(HOLDINGS_GRID, "gap-y-1.5")}>
        <Input value={symbol} onChange={(e) => setSymbol(e.currentTarget.value)} className="h-7 text-sm" />
        <Input value={name} onChange={(e) => setName(e.currentTarget.value)} className="h-7 text-sm" />
        <Input
          inputMode="decimal"
          value={quantity}
          onChange={(e) => setQuantity(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          className="h-7 text-right text-sm tabular-nums"
        />
        <div className="text-right text-sm text-muted-foreground tabular-nums">
          {holding.priceRappen != null ? formatMoney(holding.priceRappen) : "—"}
        </div>
        <div />
        <div />
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

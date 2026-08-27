"use client";

import { AlertTriangle, ChevronRight, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
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
  // Two ways into the same editor: inline on desktop, a bottom sheet on mobile
  // (the six-column row has nowhere to put six inputs at 390px).
  const [editing, setEditing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [symbol, setSymbol] = useState(holding.symbol);
  const [name, setName] = useState(holding.name);
  const [quantity, setQuantity] = useState(String(holding.quantity));

  function resetFields() {
    setSymbol(holding.symbol);
    setName(holding.name);
    setQuantity(String(holding.quantity));
    setError(null);
  }

  function openEdit() {
    resetFields();
    setEditing(true);
  }

  function openSheet() {
    resetFields();
    setSheetOpen(true);
  }

  function close() {
    setEditing(false);
    setSheetOpen(false);
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
      close();
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
    />
  );

  return (
    <>
      {/* Desktop: display row, swapped for the inline editor on click. */}
      {editing ? (
        <div
          className="hidden bg-muted/30 px-2 py-1.5 md:block"
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
          }}
        >
          <div className={cn(HOLDINGS_GRID, "gap-y-1.5")}>
            {fields(false)}
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
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={openEdit}
          onKeyDown={(e) => e.key === "Enter" && openEdit()}
          className={cn(
            HOLDINGS_GRID,
            "hidden cursor-pointer px-2 py-1.5 text-sm hover:bg-muted/60 md:grid",
            pending && "opacity-50"
          )}
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
      )}

      {/* Mobile: one compact line, tap to edit in a sheet. */}
      <button
        type="button"
        onClick={openSheet}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left active:bg-muted md:hidden",
          pending && "opacity-50"
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{holding.symbol}</span>
            {hint && (
              <AlertTriangle
                className={cn("size-3 shrink-0", holding.fetchError ? "text-amber-600" : "text-muted-foreground")}
              />
            )}
          </span>
          <span className="truncate text-xs text-muted-foreground tabular-nums">
            {formatQuantity(holding.quantity)}
            {holding.name ? ` · ${holding.name}` : ""}
          </span>
        </span>
        <span className="shrink-0 text-sm font-medium tabular-nums">
          {holding.valueRappen != null ? formatMoney(holding.valueRappen) : "—"}
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
      </button>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[90dvh] gap-0 overflow-y-auto rounded-t-xl p-0"
        >
          <SheetHeader className="border-b border-border pb-3">
            <SheetTitle>{holding.symbol}</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3 p-4">
            <div className="flex flex-col gap-3">{fields(true)}</div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Price</span>
              <span className="tabular-nums">
                {holding.priceRappen != null ? formatMoney(holding.priceRappen) : "—"}
              </span>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className={cn("pb-safe flex gap-2 pt-1", pending && "opacity-50")}>
              <Button variant="destructive" onClick={remove} disabled={pending}>
                Delete
              </Button>
              <Button variant="outline" onClick={close} disabled={pending} className="ml-auto">
                Cancel
              </Button>
              <Button onClick={save} disabled={pending}>
                Save
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * The three editable holding fields. `stacked` renders them as a labelled
 * column for the sheets; otherwise they drop straight into the desktop grid's
 * first three cells.
 */
export function HoldingFields({
  symbol,
  name,
  quantity,
  onSymbol,
  onName,
  onQuantity,
  onEnter,
  stacked = false,
  placeholders = false,
}: {
  symbol: string;
  name: string;
  quantity: string;
  onSymbol: (value: string) => void;
  onName: (value: string) => void;
  onQuantity: (value: string) => void;
  onEnter: () => void;
  stacked?: boolean;
  /** Show the add-row's hint text ("Name (optional)") — an existing holding always has values. */
  placeholders?: boolean;
}) {
  const inputs = [
    {
      label: "Symbol",
      placeholder: "Symbol (VWRL.SW)",
      value: symbol,
      onChange: onSymbol,
      className: "h-8 text-sm md:h-7",
      inputMode: undefined,
    },
    {
      label: "Name",
      placeholder: "Name (optional)",
      value: name,
      onChange: onName,
      className: "h-8 text-sm md:h-7",
      inputMode: undefined,
    },
    {
      label: "Quantity",
      placeholder: "Quantity",
      value: quantity,
      onChange: onQuantity,
      className: "h-8 text-right text-sm tabular-nums md:h-7",
      inputMode: "decimal" as const,
    },
  ];

  return (
    <>
      {inputs.map((field) => {
        const input = (
          <Input
            inputMode={field.inputMode}
            placeholder={placeholders ? field.placeholder : undefined}
            value={field.value}
            onChange={(e) => field.onChange(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && onEnter()}
            className={field.className}
            aria-label={field.label}
          />
        );
        if (!stacked) return <div key={field.label}>{input}</div>;
        return (
          <div key={field.label} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground uppercase">{field.label}</span>
            {input}
          </div>
        );
      })}
    </>
  );
}

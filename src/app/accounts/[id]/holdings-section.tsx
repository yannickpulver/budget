"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/currency";
import type { HoldingsView } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AddHoldingRow } from "./add-holding-row";
import { HoldingRow } from "./holding-row";
import { HOLDINGS_GRID } from "./holdings-grid";
import { refreshPricesAction, syncBalanceAction } from "./holdings-actions";

function formatUpdatedAt(iso: string | null): string {
  if (!iso) return "never fetched";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function HoldingsSection({ accountId, view }: { accountId: number; view: HoldingsView }) {
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const autoTriggered = useRef(false);

  // Fetch on demand only: if any held symbol is missing a price or older
  // than 24h, kick off one refresh when the page is viewed. Never on every
  // load — `needsRefresh` is false whenever the cache is fresh enough.
  useEffect(() => {
    if (view.needsRefresh && view.holdings.length > 0 && !autoTriggered.current) {
      autoTriggered.current = true;
      startTransition(async () => {
        await refreshPricesAction(accountId);
      });
    }
  }, [accountId, view.needsRefresh, view.holdings.length]);

  function doRefresh() {
    setNotice(null);
    startTransition(async () => {
      const result = await refreshPricesAction(accountId);
      if (result.failed.length > 0) {
        setNotice(`${result.failed.length} price${result.failed.length === 1 ? "" : "s"} failed to update.`);
      }
    });
  }

  function doSync() {
    setNotice(null);
    startTransition(async () => {
      const result = await syncBalanceAction(accountId);
      if (!result.ok) setNotice(result.error);
    });
  }

  const delta = view.totalValueRappen - view.accountBalance;
  const inSync = delta === 0;

  return (
    <div className="border-b border-border px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="text-sm font-semibold">Holdings</h2>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Prices updated {formatUpdatedAt(view.oldestFetchedAt)}</span>
          <Button size="sm" variant="outline" onClick={doRefresh} disabled={pending}>
            <RefreshCw className={cn("size-3.5", pending && "animate-spin")} />
            Refresh prices
          </Button>
        </div>
      </div>

      <div className={cn(HOLDINGS_GRID, "px-2 pb-1.5 text-xs font-medium text-muted-foreground uppercase")}>
        <div>Symbol</div>
        <div className="hidden md:block">Name</div>
        <div className="hidden text-right md:block">Quantity</div>
        <div className="hidden text-right md:block">Price</div>
        <div className="text-right">Value</div>
        <div className="hidden md:block" />
      </div>

      <div className="rounded-lg border border-border">
        <div className="border-b border-border">
          <AddHoldingRow accountId={accountId} />
        </div>
        <div className="divide-y divide-border/60">
          {/* One wrapper per holding: HoldingRow renders a desktop row and a
              mobile row, and `divide-y` would otherwise rule between them. */}
          {view.holdings.map((holding) => (
            <div key={holding.id}>
              <HoldingRow holding={holding} accountId={accountId} />
            </div>
          ))}
          {view.holdings.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">No holdings yet.</div>
          )}
        </div>
      </div>

      {view.holdings.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md bg-muted/40 px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-x-4">
            <span>
              Portfolio value: <span className="font-medium tabular-nums">{formatMoney(view.totalValueRappen)}</span>
            </span>
            <span>
              Account balance: <span className="font-medium tabular-nums">{formatMoney(view.accountBalance)}</span>
            </span>
          </div>
          <Button
            size="sm"
            variant={inSync ? "outline" : "default"}
            onClick={doSync}
            disabled={pending || inSync || !view.hasAllPrices}
            title={!view.hasAllPrices ? "Fetch prices for every holding first." : undefined}
          >
            {inSync ? "Balance in sync" : `Sync balance (${delta > 0 ? "+" : ""}${formatMoney(delta)})`}
          </Button>
        </div>
      )}

      {notice && <p className="mt-1.5 text-xs text-destructive">{notice}</p>}
    </div>
  );
}

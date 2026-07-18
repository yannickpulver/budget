"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/currency";
import type { AccountDetail } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { closeAccountAction, deleteAccountAction, renameAccountAction, reopenAccountAction } from "../actions";

const TYPE_LABEL: Record<AccountDetail["type"], string> = {
  checking: "Checking",
  savings: "Savings",
  cash: "Cash",
  credit: "Credit card",
  tracking: "Tracking",
};

function balanceClass(value: number): string {
  return value < 0 ? "text-red-600" : "text-foreground";
}

export function AccountHeader({ detail }: { detail: AccountDetail }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(detail.name);

  function saveName() {
    setEditingName(false);
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === detail.name) {
      setName(detail.name);
      return;
    }
    startTransition(async () => {
      const result = await renameAccountAction(detail.id, trimmed);
      if (!result.ok) {
        setError(result.error);
        setName(detail.name);
      }
    });
  }

  function toggleClosed() {
    setError(null);
    startTransition(async () => {
      const result = detail.closed
        ? await reopenAccountAction(detail.id)
        : await closeAccountAction(detail.id);
      if (!result.ok) setError(result.error);
    });
  }

  function remove() {
    if (!confirm(`Delete "${detail.name}"? This cannot be undone.`)) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteAccountAction(detail.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/");
    });
  }

  return (
    <header className="border-b border-border px-4 py-3">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {editingName ? (
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveName();
                  } else if (e.key === "Escape") {
                    setName(detail.name);
                    setEditingName(false);
                  }
                }}
                className="h-8 max-w-xs text-lg font-semibold"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingName(true)}
                className="truncate rounded-md px-1 -mx-1 text-lg font-semibold hover:bg-muted"
              >
                {detail.name}
              </button>
            )}
            <Badge variant="outline">{TYPE_LABEL[detail.type]}</Badge>
            {detail.closed && <Badge variant="secondary">Closed</Badge>}
          </div>

          <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              Cleared:{" "}
              <span className={cn("tabular-nums", balanceClass(detail.clearedBalance))}>
                {formatCurrency(detail.clearedBalance, detail.currency)}
              </span>
            </span>
            <span>
              Uncleared:{" "}
              <span className={cn("tabular-nums", balanceClass(detail.unclearedBalance))}>
                {formatCurrency(detail.unclearedBalance, detail.currency)}
              </span>
            </span>
          </div>
          {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className={cn("text-2xl font-semibold tabular-nums", balanceClass(detail.balance))}>
            {formatCurrency(detail.balance, detail.currency)}
          </div>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={toggleClosed}
              disabled={pending || (!detail.closed && detail.balance !== 0)}
              title={
                !detail.closed && detail.balance !== 0
                  ? "Balance must be zero to close an account"
                  : undefined
              }
            >
              {detail.closed ? "Reopen" : "Close account"}
            </Button>
            {detail.transactionCount === 0 && (
              <Button size="sm" variant="destructive" onClick={remove} disabled={pending}>
                Delete
              </Button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

"use client";

import { ImageDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency } from "@/lib/currency";
import type { AccountDetail, CategoryGroupOption, TransferTarget } from "@/lib/queries";
import { cn } from "@/lib/utils";
import {
  closeAccountAction,
  deleteAccountAction,
  refreshPayeeIconsAction,
  renameAccountAction,
  reopenAccountAction,
  updateAccountTypeAction,
} from "../actions";
import { AccountIconPopover } from "./account-icon-popover";
import { ImportCsvDialog } from "./import-csv-dialog";
import { ImportStatementDialog } from "./import-statement-dialog";
import { SetBalancePopover } from "./set-balance-popover";

const TYPE_LABEL: Record<AccountDetail["type"], string> = {
  checking: "Checking",
  savings: "Savings",
  cash: "Cash",
  credit: "Credit card",
  giftcard: "Giftcard",
  tracking: "Tracking",
};

const ACCOUNT_TYPES = Object.keys(TYPE_LABEL) as AccountDetail["type"][];

function balanceClass(value: number): string {
  return value < 0 ? "text-red-600" : "text-foreground";
}

export function AccountHeader({
  detail,
  groups,
  transferTargets,
  payeeSuggestions,
}: {
  detail: AccountDetail;
  groups: CategoryGroupOption[];
  transferTargets: TransferTarget[];
  payeeSuggestions: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(detail.name);
  const [iconsPending, startIconsTransition] = useTransition();
  const [iconsNotice, setIconsNotice] = useState<string | null>(null);

  function fetchPayeeIcons() {
    setIconsNotice(null);
    startIconsTransition(async () => {
      const result = await refreshPayeeIconsAction(detail.id);
      setIconsNotice(`${result.fetched} added, ${result.missed} missed, ${result.skipped} skipped.`);
    });
  }

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

  function changeType(type: AccountDetail["type"]) {
    if (type === detail.type) return;
    setError(null);
    startTransition(async () => {
      const result = await updateAccountTypeAction(detail.id, type);
      if (!result.ok) setError(result.error);
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
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <AccountIconPopover accountId={detail.id} type={detail.type} icon={detail.icon} />
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
                className="h-8 max-w-xs min-w-0 text-lg font-semibold"
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
            <Select
              value={detail.type}
              onValueChange={(v) => changeType(v as AccountDetail["type"])}
              disabled={pending}
            >
              <SelectTrigger
                size="sm"
                className="h-6 w-auto gap-1 rounded-full border-none bg-muted px-2.5 text-xs font-medium shadow-none"
              >
                <SelectValue>{TYPE_LABEL[detail.type]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ACCOUNT_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {TYPE_LABEL[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {detail.closed && <Badge variant="secondary">Closed</Badge>}
          </div>

          {/* Two tiles side by side on a phone, one line on desktop. */}
          <div className="mt-1.5 grid grid-cols-2 gap-2 text-xs text-muted-foreground md:flex md:items-center md:gap-3">
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

        <div className="flex shrink-0 flex-col gap-2 md:items-end">
          <div className="flex items-center gap-2">
            <div className={cn("text-2xl font-semibold tabular-nums", balanceClass(detail.balance))}>
              {formatCurrency(detail.balance, detail.currency)}
            </div>
            {detail.type === "tracking" && (
              <SetBalancePopover accountId={detail.id} balance={detail.balance} />
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={fetchPayeeIcons}
              disabled={iconsPending}
              aria-label="Fetch payee icons"
            >
              <ImageDown className={cn("size-3.5", iconsPending && "animate-spin")} />
              <span className="hidden md:inline">Fetch payee icons</span>
            </Button>
            <ImportCsvDialog
              accountId={detail.id}
              currency={detail.currency}
              groups={groups}
              transferTargets={transferTargets}
              payeeSuggestions={payeeSuggestions}
            />
            {detail.type === "tracking" && (
              <ImportStatementDialog accountId={detail.id} currency={detail.currency} />
            )}
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
              {detail.closed ? "Reopen" : "Close"}
              <span className="hidden md:inline">{detail.closed ? "" : " account"}</span>
            </Button>
            {detail.transactionCount === 0 && (
              <Button size="sm" variant="destructive" onClick={remove} disabled={pending}>
                Delete
              </Button>
            )}
          </div>
          {iconsNotice && <p className="text-xs text-muted-foreground">{iconsNotice}</p>}
        </div>
      </div>
    </header>
  );
}

"use client";

import { CircleCheck } from "lucide-react";
import { useState } from "react";
import { PayeeAvatar } from "@/components/payee-avatar";
import type { AccountType } from "@/lib/budget-math";
import { formatMoney } from "@/lib/currency";
import type { AccountRef, CategoryGroupOption, RegisterRow, TransferTarget } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { formatDateDisplay } from "./transaction-fields";
import { TransactionSheet } from "./transaction-sheet";

/**
 * Two-line register row for phones: payee and amount on top, the supporting
 * detail (category or transfer target · memo · date) muted underneath.
 * Tapping it opens {@link TransactionSheet} — there is no inline editing at
 * this width, the cells are too small to hit.
 */
export function MobileTransactionRow({
  row,
  accountId,
  accountType,
  groups,
  accountsById,
  payeeSuggestions,
  transferTargets,
  iconUrl,
}: {
  row: RegisterRow;
  accountId: number;
  accountType: AccountType;
  groups: CategoryGroupOption[];
  accountsById: Map<number, AccountRef>;
  payeeSuggestions: string[];
  transferTargets: TransferTarget[];
  iconUrl?: string;
}) {
  const [open, setOpen] = useState(false);

  const isTransfer = row.transferAccountId != null;
  const otherAccount = row.transferAccountId != null ? accountsById.get(row.transferAccountId) : undefined;
  const isFuture = row.date > new Date().toISOString().slice(0, 10);

  const detail = [
    isTransfer ? `→ ${row.transferAccountName ?? "?"}` : (row.categoryName ?? "Ready to Assign"),
    row.memo || null,
    formatDateDisplay(row.date),
  ].filter(Boolean) as string[];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left active:bg-muted md:hidden",
          isFuture && "bg-sky-50/60"
        )}
      >
        {isTransfer ? (
          <PayeeAvatar payee="" transfer />
        ) : (
          <PayeeAvatar payee={row.payee} iconUrl={iconUrl} />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">
              {isTransfer ? (row.transferAccountName ?? "?") : row.payee || "—"}
            </span>
            <span
              className={cn(
                "shrink-0 text-sm tabular-nums",
                row.amount < 0 ? "text-red-600" : "text-foreground"
              )}
            >
              {formatMoney(row.amount)}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{detail.join(" · ")}</span>
            {row.cleared && <CircleCheck className="size-3 shrink-0 text-emerald-600" />}
          </span>
        </span>
      </button>

      <TransactionSheet
        open={open}
        onOpenChange={setOpen}
        row={row}
        accountId={accountId}
        accountType={accountType}
        otherAccountType={otherAccount?.type}
        groups={groups}
        transferTargets={transferTargets}
        payeeSuggestions={payeeSuggestions}
      />
    </>
  );
}

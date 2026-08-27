"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import type { CategoryGroupOption, TransferTarget } from "@/lib/queries";
import { TransactionSheet } from "./transaction-sheet";

/**
 * Below `md` the add-transaction row is a floating button instead — the
 * seven inline fields it holds on desktop can't fit, so it opens the same
 * {@link TransactionSheet} in create mode.
 */
export function MobileAddTransaction({
  accountId,
  groups,
  transferTargets,
  payeeSuggestions,
  defaultCategoryId,
}: {
  accountId: number;
  groups: CategoryGroupOption[];
  transferTargets: TransferTarget[];
  payeeSuggestions: string[];
  defaultCategoryId?: number | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Add transaction"
        className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-30 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg active:translate-y-px md:hidden"
      >
        <Plus className="size-6" />
      </button>

      <TransactionSheet
        open={open}
        onOpenChange={setOpen}
        accountId={accountId}
        groups={groups}
        transferTargets={transferTargets}
        payeeSuggestions={payeeSuggestions}
        defaultCategoryId={defaultCategoryId}
      />
    </>
  );
}

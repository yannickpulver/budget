"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { BarList } from "@/components/charts/bar-list";
import { formatCurrency } from "@/lib/currency";
import { barWidth, formatDelta, isNoChange } from "@/lib/stats-format";
import type { GroupSpending } from "@/lib/stats-queries";
import type { StatsPeriod } from "@/lib/stats-period";
import { cn } from "@/lib/utils";

/** 0.184 -> "18%". */
function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * Spending by category group as bar-list rows that expand into their
 * categories. Group bars are scaled against the largest group; a group's
 * categories are scaled against the largest category *inside that group*, so an
 * opened group reads as its own little chart rather than as four invisible
 * slivers next to the biggest group in the period.
 *
 * The only client component on the overview page — the open/closed state is
 * local and deliberately not persisted in the URL, so expanding a group never
 * costs a server round-trip or a scroll jump.
 */
export function SpendingGroups({
  groups,
  currency,
  period,
  comparisonLabel,
}: {
  groups: GroupSpending[];
  currency: string;
  period: StatsPeriod;
  /** e.g. "vs Jul" — omitted for all-time, which has nothing to compare against. */
  comparisonLabel?: string | null;
}) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const ceiling = Math.max(1, ...groups.map((group) => group.outflow));

  return (
    <div className="flex flex-col gap-1">
      {groups.map((group) => {
        const isOpen = open[group.groupId] === true;
        const change = group.previousOutflow == null ? null : group.outflow - group.previousOutflow;
        const categoryCeiling = Math.max(1, ...group.categories.map((c) => c.outflow));

        return (
          <div key={group.groupId}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen((prev) => ({ ...prev, [group.groupId]: !isOpen }))}
              className="-mx-1.5 block w-full rounded-md px-1.5 py-1.5 text-left hover:bg-muted"
            >
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-baseline gap-1">
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      "size-3.5 shrink-0 translate-y-0.5 text-muted-foreground transition-transform",
                      isOpen && "rotate-90"
                    )}
                  />
                  <span className="truncate">{group.name}</span>
                </span>
                <span className="flex shrink-0 items-baseline gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    {formatShare(group.share)} · {group.count}×
                  </span>
                  <span className="tabular-nums">{formatCurrency(group.outflow, currency)}</span>
                </span>
              </div>

              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-red-600/70"
                  style={{ width: `${barWidth(group.outflow, ceiling)}%` }}
                />
              </div>

              {change != null && !isNoChange(change) && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatDelta(change, null, currency)}
                  {comparisonLabel ? ` ${comparisonLabel}` : ""}
                </div>
              )}
            </button>

            {isOpen && group.categories.length > 0 && (
              <BarList
                className="mt-1 mb-2 border-l border-border pl-3"
                items={group.categories.map((category) => ({
                  key: String(category.categoryId),
                  label: category.name,
                  value: category.outflow,
                  hint: `${category.count}×`,
                  href: `/stats/categories?cat=${category.categoryId}&period=${period}`,
                }))}
                formatValue={(value) => formatCurrency(value, currency)}
                colorClassName="bg-red-600/40"
                max={categoryCeiling}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

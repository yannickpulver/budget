"use client";

import type { ActivityEntry } from "@/lib/budget-math";
import { formatMoney } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const MAX_LINES = 12;

/** "YYYY-MM-DD" -> "dd.mm." */
function formatDayMonth(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${day}.${month}.`;
}

/** Cell showing a category's Activity for the month; hover/focus reveals the contributing transactions. */
export function ActivityCell({
  activity,
  transactions,
}: {
  activity: number;
  transactions: ActivityEntry[];
}) {
  if (activity === 0 || transactions.length === 0) {
    return (
      <div className="pr-2 text-right text-sm text-muted-foreground tabular-nums">
        {formatMoney(activity)}
      </div>
    );
  }

  const shown = transactions.slice(0, MAX_LINES);
  const hiddenCount = transactions.length - shown.length;

  return (
    <Tooltip>
      <TooltipTrigger className="w-full cursor-default rounded-md pr-2 text-right text-sm text-muted-foreground tabular-nums outline-none hover:text-foreground focus-visible:text-foreground">
        {formatMoney(activity)}
      </TooltipTrigger>
      <TooltipContent
        variant="light"
        showArrow={false}
        side="bottom"
        align="end"
        className="flex w-72 max-w-none flex-col items-stretch gap-0 px-0 py-1"
      >
        <ul className="flex flex-col divide-y divide-border/60">
          {shown.map((txn) => (
            <li key={txn.id} className="flex items-center gap-2 px-2.5 py-1">
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatDayMonth(txn.date)}
              </span>
              <span className="min-w-0 flex-1 truncate">{txn.payee || "—"}</span>
              <span
                className={cn(
                  "shrink-0 tabular-nums",
                  txn.amount < 0 ? "text-red-600" : "text-foreground"
                )}
              >
                {formatMoney(txn.amount)}
              </span>
            </li>
          ))}
          {hiddenCount > 0 && (
            <li className="px-2.5 py-1 text-muted-foreground">+{hiddenCount} more</li>
          )}
        </ul>
        {transactions.length > 1 && (
          <div className="flex items-center justify-between border-t border-border/60 px-2.5 pt-1.5 font-medium">
            <span>Total</span>
            <span className="tabular-nums">{formatMoney(activity)}</span>
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

import Link from "next/link";
import { PayeeAvatar } from "@/components/payee-avatar";
import { formatCurrency } from "@/lib/currency";
import { MONTH_SHORT_NAMES } from "@/lib/stats-period";
import type { LargestTransaction } from "@/lib/stats-queries";

/** "2026-08-12" -> "12 Aug". */
function shortDate(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${day} ${MONTH_SHORT_NAMES[month - 1]}`;
}

/**
 * The period's biggest single purchases. Each row is a link into the register
 * of the account it was booked on — the place you'd go to actually do
 * something about it.
 */
export function LargestTransactions({
  rows,
  currency,
  iconUrls,
}: {
  rows: LargestTransaction[];
  currency: string;
  /** payee -> icon url, from `getPayeeIconMap`. */
  iconUrls: Record<string, string>;
}) {
  return (
    <div className="flex flex-col">
      {rows.map((row) => (
        <Link
          key={row.id}
          href={`/accounts/${row.accountId}`}
          className="-mx-1.5 flex items-center gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-muted"
        >
          <PayeeAvatar payee={row.payee} iconUrl={iconUrls[row.payee]} className="size-7 text-xs" />

          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{row.payee}</div>
            <div className="truncate text-xs text-muted-foreground">{row.categoryName}</div>
          </div>

          <div className="shrink-0 text-right">
            <div className="text-sm tabular-nums">{formatCurrency(row.amount, currency)}</div>
            <div className="text-xs text-muted-foreground tabular-nums">{shortDate(row.date)}</div>
          </div>
        </Link>
      ))}
    </div>
  );
}

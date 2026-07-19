"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, PiggyBank, Tags, Wallet } from "lucide-react";
import { useState } from "react";
import { AddAccountDialog } from "@/app/accounts/add-account-dialog";
import { AccountIcon } from "@/components/account-icon";
import { formatMoney } from "@/lib/currency";
import type { AccountBalance, SidebarData } from "@/lib/queries";
import { cn } from "@/lib/utils";

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function balanceClass(value: number): string {
  return value < 0 ? "text-red-600" : "text-foreground";
}

export function Sidebar({ data }: { data: SidebarData }) {
  const pathname = usePathname();
  const [closedOpen, setClosedOpen] = useState(false);
  const hasAnyAccounts =
    data.budget.length > 0 ||
    data.giftcards.length > 0 ||
    data.tracking.length > 0 ||
    data.closed.length > 0;

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="px-4 py-4 text-sm font-semibold tracking-tight">newbudget</div>

      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        <SidebarLink href={`/budget/${currentMonthKey()}`} active={pathname.startsWith("/budget")}>
          <Wallet className="size-4" />
          Budget
        </SidebarLink>
        <SidebarLink href="/settings/categories" active={pathname.startsWith("/settings/categories")}>
          <Tags className="size-4" />
          Categories
        </SidebarLink>

        {!hasAnyAccounts && (
          <div className="mx-1 mt-4 rounded-md border border-dashed border-border p-3 text-center">
            <PiggyBank className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-1.5 text-xs font-medium">No accounts yet</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Add your first account to start budgeting.
            </p>
          </div>
        )}

        <AccountGroup
          title="Budget"
          accounts={data.budget}
          total={data.budgetTotal}
          pathname={pathname}
        />
        <AccountGroup
          title="Giftcards"
          accounts={data.giftcards}
          total={data.giftcardsTotal}
          pathname={pathname}
        />
        <AccountGroup
          title="Tracking"
          accounts={data.tracking}
          total={data.trackingTotal}
          pathname={pathname}
        />

        {data.closed.length > 0 && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setClosedOpen((o) => !o)}
              className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className={cn("size-3 transition-transform", closedOpen && "rotate-90")} />
              Closed ({data.closed.length})
            </button>
            {closedOpen && (
              <div className="mt-0.5">
                {data.closed.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    active={pathname === `/accounts/${account.id}`}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-4">
          <AddAccountDialog />
        </div>
      </nav>

      <div className="border-t border-border px-4 py-3">
        <div className="flex items-center justify-between text-sm font-medium">
          <span>Net worth</span>
          <span className={cn("tabular-nums", balanceClass(data.netWorth))}>
            {formatMoney(data.netWorth)}
          </span>
        </div>
      </div>
    </aside>
  );
}

function SidebarLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      {children}
    </Link>
  );
}

function AccountGroup({
  title,
  accounts,
  total,
  pathname,
}: {
  title: string;
  accounts: AccountBalance[];
  total: number;
  pathname: string;
}) {
  if (accounts.length === 0) return null;

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between px-2 py-1 text-xs font-medium text-muted-foreground uppercase">
        <span>{title}</span>
        <span className={cn("tabular-nums", balanceClass(total))}>{formatMoney(total)}</span>
      </div>
      <div>
        {accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            active={pathname === `/accounts/${account.id}`}
          />
        ))}
      </div>
    </div>
  );
}

function AccountRow({ account, active }: { account: AccountBalance; active: boolean }) {
  return (
    <Link
      href={`/accounts/${account.id}`}
      className={cn(
        "flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-sm",
        active ? "bg-muted font-medium text-foreground" : "text-foreground/80 hover:bg-muted hover:text-foreground"
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <AccountIcon type={account.type} icon={account.icon} />
        <span className="truncate">{account.name}</span>
      </span>
      <span className={cn("shrink-0 tabular-nums", balanceClass(account.balance))}>
        {formatMoney(account.balance)}
      </span>
    </Link>
  );
}

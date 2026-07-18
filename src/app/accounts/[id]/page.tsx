import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { db } from "@/db";
import {
  getAccountDetail,
  getAccountRegister,
  getCategoryOptions,
  getTransferTargets,
  listAccounts,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AccountHeader } from "./account-header";
import { AddTransactionRow } from "./add-transaction-row";
import { REGISTER_GRID } from "./grid";
import { SearchBox } from "./search-box";
import { TransactionRow } from "./transaction-row";

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ search?: string; page?: string }>;
}) {
  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) notFound();

  const detail = getAccountDetail(id, db);
  if (!detail) notFound();

  const { search, page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);

  const register = getAccountRegister(id, { search, page }, db);
  const groups = getCategoryOptions(db);
  const transferTargets = getTransferTargets(id, db);
  const accountsById = new Map(listAccounts(db).map((a) => [a.id, a]));

  const totalPages = Math.max(1, Math.ceil(register.total / register.pageSize));

  return (
    <div className="flex flex-1 flex-col">
      <AccountHeader detail={detail} />

      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <SearchBox />
        <div className="text-xs text-muted-foreground">
          {register.total} transaction{register.total === 1 ? "" : "s"}
        </div>
      </div>

      <div className="flex-1 px-4 pb-4">
        <div className={cn(REGISTER_GRID, "px-2 pb-1.5 text-xs font-medium text-muted-foreground uppercase")}>
          <div>Date</div>
          <div>Payee</div>
          <div>Category</div>
          <div>Memo</div>
          <div className="text-right">Outflow</div>
          <div className="text-right">Inflow</div>
          <div className="text-center">✓</div>
        </div>

        <div className="rounded-lg border border-border">
          <div className="border-b border-border">
            <AddTransactionRow accountId={id} groups={groups} transferTargets={transferTargets} />
          </div>

          <div className="divide-y divide-border/60">
            {register.rows.map((row) => (
              <TransactionRow
                key={row.id}
                row={row}
                accountId={id}
                accountType={detail.type}
                groups={groups}
                accountsById={accountsById}
              />
            ))}
            {register.rows.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {search ? "No transactions match your search." : "No transactions yet."}
              </div>
            )}
          </div>
        </div>

        {totalPages > 1 && (
          <Pagination accountId={id} page={register.page} totalPages={totalPages} search={search} />
        )}
      </div>
    </div>
  );
}

function pageHref(accountId: number, page: number, search: string | undefined): string {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return `/accounts/${accountId}${query ? `?${query}` : ""}`;
}

function Pagination({
  accountId,
  page,
  totalPages,
  search,
}: {
  accountId: number;
  page: number;
  totalPages: number;
  search: string | undefined;
}) {
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <div className="mt-3 flex items-center justify-center gap-3 text-sm">
      <PageLink href={hasPrev ? pageHref(accountId, page - 1, search) : null}>
        <ChevronLeft className="size-4" />
      </PageLink>
      <span className="text-xs text-muted-foreground tabular-nums">
        Page {page} of {totalPages}
      </span>
      <PageLink href={hasNext ? pageHref(accountId, page + 1, search) : null}>
        <ChevronRight className="size-4" />
      </PageLink>
    </div>
  );
}

function PageLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href) {
    return (
      <span className="flex size-7 items-center justify-center rounded-md text-muted-foreground/40">
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {children}
    </Link>
  );
}

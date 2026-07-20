import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight, Info, Tags, Wallet } from "lucide-react";
import { db } from "@/db";
import { prevMonthKey, nextMonthKey } from "@/lib/budget-math";
import { formatCurrency, formatMoney, formatMoneyWhole } from "@/lib/currency";
import {
  BUDGET_FILTER_KEYS,
  countBudgetFilterMatches,
  currentMonth,
  filterGroupViews,
  getBudgetView,
  listAccounts,
  type BudgetFilterKey,
  type CategoryView,
  type GroupView,
  type RtaAdjustment,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import { ActivityCell } from "./activity-cell";
import { AssignCell } from "./assign-cell";
import { AvailablePill } from "./available-pill";
import { GoalControl } from "./goal-control";

const MONTH_RE = /^(\d{4})-(\d{2})$/;

function isValidMonth(month: string): boolean {
  const match = MONTH_RE.exec(month);
  if (!match) return false;
  const mon = Number(match[2]);
  return mon >= 1 && mon <= 12;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ month: string }>;
}): Promise<Metadata> {
  const { month } = await params;
  return { title: isValidMonth(month) ? `${monthLabel(month)} · budget` : "budget" };
}

const GRID = "grid grid-cols-[minmax(12rem,1fr)_7.5rem_7.5rem_8.5rem] items-center gap-x-2";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthLabel(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return `${MONTH_NAMES[mon - 1]} ${year}`;
}

const FILTER_LABELS: Record<BudgetFilterKey, string> = {
  underfunded: "Needs funding",
  negative: "Negative",
};

/** Parses `?filter=` into the known keys it contains, in canonical order (unknown values dropped). */
function parseFilterParam(raw: string | undefined): BudgetFilterKey[] {
  if (!raw) return [];
  const requested = new Set(raw.split(","));
  return BUDGET_FILTER_KEYS.filter((key) => requested.has(key));
}

function serializeFilters(filters: BudgetFilterKey[]): string {
  return filters.length > 0 ? `?filter=${filters.join(",")}` : "";
}

function monthHref(month: string, filters: BudgetFilterKey[]): string {
  return `/budget/${month}${serializeFilters(filters)}`;
}

function toggleFilterHref(month: string, active: BudgetFilterKey[], key: BudgetFilterKey): string {
  const set = new Set(active);
  if (set.has(key)) set.delete(key);
  else set.add(key);
  return monthHref(
    month,
    BUDGET_FILTER_KEYS.filter((k) => set.has(k))
  );
}

export default async function BudgetPage({
  params,
  searchParams,
}: {
  params: Promise<{ month: string }>;
  searchParams: Promise<{ filter?: string }>;
}) {
  const { month } = await params;
  if (!isValidMonth(month)) notFound();

  const { filter } = await searchParams;
  const activeFilters = parseFilterParam(filter);

  const view = getBudgetView(month);
  const first = view.months[0];
  const last = view.months[view.months.length - 1];
  const hasPrev = month > first;
  const hasNext = month < last;
  const today = currentMonth();
  const hasAccounts = listAccounts(db).length > 0;

  const displayedGroups = filterGroupViews(view.groups, activeFilters);

  return (
    <div className="flex flex-1 flex-col">
      <Header
        month={month}
        hasPrev={hasPrev}
        hasNext={hasNext}
        today={today}
        activeFilters={activeFilters}
        readyToAssign={view.readyToAssign}
        totalUnderfunded={view.totalUnderfunded}
        currency={view.currency}
        rtaAdjustment={view.rtaAdjustment}
      />

      <div className="px-4 py-3">
        {view.groups.length === 0 ? (
          <EmptyState hasAccounts={hasAccounts} />
        ) : (
          <>
            <FilterChips
              month={month}
              activeFilters={activeFilters}
              needsFundingCount={countBudgetFilterMatches(view.groups, "underfunded")}
              negativeCount={countBudgetFilterMatches(view.groups, "negative")}
            />

            {displayedGroups.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing matches.</p>
            ) : (
              <>
                <div className={cn(GRID, "px-2 pb-1.5 text-xs font-medium text-muted-foreground uppercase")}>
                  <div>Category</div>
                  <div className="text-right">Assigned</div>
                  <div className="text-right">Activity</div>
                  <div className="text-right">Available</div>
                </div>

                <div className="divide-y divide-border rounded-lg border border-border">
                  {displayedGroups.map((group) => (
                    <Group
                      key={group.id}
                      group={group}
                      allGroups={view.groups}
                      month={month}
                      currency={view.currency}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FilterChips({
  month,
  activeFilters,
  needsFundingCount,
  negativeCount,
}: {
  month: string;
  activeFilters: BudgetFilterKey[];
  needsFundingCount: number;
  negativeCount: number;
}) {
  const counts: Record<BudgetFilterKey, number> = {
    underfunded: needsFundingCount,
    negative: negativeCount,
  };

  return (
    <div className="mb-2 flex items-center gap-1.5">
      {BUDGET_FILTER_KEYS.map((key) => (
        <FilterChip
          key={key}
          href={toggleFilterHref(month, activeFilters, key)}
          active={activeFilters.includes(key)}
          label={FILTER_LABELS[key]}
          count={counts[key]}
        />
      ))}
    </div>
  );
}

function FilterChip({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium tabular-nums transition-colors",
        active
          ? "border-transparent bg-foreground text-background hover:bg-foreground/90"
          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
    >
      {label} · {count}
    </Link>
  );
}

function EmptyState({ hasAccounts }: { hasAccounts: boolean }) {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-dashed border-border p-8 text-center">
      <Wallet className="mx-auto size-6 text-muted-foreground" />
      <h2 className="mt-3 text-sm font-semibold">
        {hasAccounts ? "No categories to budget yet" : "Welcome to budget"}
      </h2>
      <p className="mt-1.5 text-sm text-muted-foreground">
        {hasAccounts
          ? "All your categories are hidden, or none exist yet. Add or unhide some in Categories."
          : "Add your first account in the sidebar to get started. A small starter set of budget categories is created automatically — rename, hide, or delete anything you don't need."}
      </p>
      <div className="mt-4 flex flex-col items-center gap-2">
        <Link
          href="/settings/categories"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          <Tags className="size-3.5" />
          Manage categories
        </Link>
      </div>
      <p className="mt-5 border-t border-border pt-3 text-xs text-muted-foreground">
        Migrating from YNAB? Run <code className="rounded bg-muted px-1 py-0.5">pnpm migrate:ynab</code> from
        the command line — see the README for setup instructions.
      </p>
    </div>
  );
}

function Header({
  month,
  hasPrev,
  hasNext,
  today,
  activeFilters,
  readyToAssign,
  totalUnderfunded,
  currency,
  rtaAdjustment,
}: {
  month: string;
  hasPrev: boolean;
  hasNext: boolean;
  today: string;
  activeFilters: BudgetFilterKey[];
  readyToAssign: number;
  totalUnderfunded: number;
  currency: string;
  rtaAdjustment: RtaAdjustment | null;
}) {
  const rtaClass =
    readyToAssign > 0
      ? "text-emerald-600"
      : readyToAssign < 0
        ? "text-red-600"
        : "text-muted-foreground";

  const adjustmentHint =
    rtaAdjustment != null
      ? `Includes migration alignment of ${formatCurrency(rtaAdjustment.amount, currency)}, set ${monthLabel(rtaAdjustment.month)}`
      : undefined;

  return (
    <header className="flex items-center justify-between gap-6 border-b border-border px-4 py-3">
      <div className="flex items-center gap-1">
        <NavArrow href={hasPrev ? monthHref(prevMonthKey(month), activeFilters) : null} label="Previous month">
          <ChevronLeft className="size-4" />
        </NavArrow>
        <div className="min-w-48 text-center text-xl font-semibold">{monthLabel(month)}</div>
        <NavArrow href={hasNext ? monthHref(nextMonthKey(month), activeFilters) : null} label="Next month">
          <ChevronRight className="size-4" />
        </NavArrow>
        {month !== today && (
          <Link
            href={monthHref(today, activeFilters)}
            className="ml-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Today
          </Link>
        )}
      </div>

      <div className="text-right">
        <div className={cn("text-2xl font-semibold tabular-nums", rtaClass)} title={adjustmentHint}>
          {formatCurrency(readyToAssign, currency)}
        </div>
        <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
          Ready to Assign
          {adjustmentHint != null && (
            <span title={adjustmentHint} aria-label={adjustmentHint} className="cursor-help text-muted-foreground/60">
              <Info className="size-3" />
            </span>
          )}
        </div>
        {totalUnderfunded > 0 && (
          <div className="mt-0.5 text-xs text-amber-600 tabular-nums">
            {formatCurrency(totalUnderfunded, currency)} still needed for goals
          </div>
        )}
      </div>
    </header>
  );
}

function NavArrow({
  href,
  label,
  children,
}: {
  href: string | null;
  label: string;
  children: React.ReactNode;
}) {
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
      aria-label={label}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {children}
    </Link>
  );
}

function Group({
  group,
  allGroups,
  month,
  currency,
}: {
  group: GroupView;
  allGroups: GroupView[];
  month: string;
  currency: string;
}) {
  const totals = group.categories.reduce(
    (acc, c) => ({
      assigned: acc.assigned + c.assigned,
      activity: acc.activity + c.activity,
      available: acc.available + c.available,
    }),
    { assigned: 0, activity: 0, available: 0 }
  );

  return (
    <details open className="group">
      <summary
        className={cn(
          GRID,
          "cursor-pointer list-none bg-muted/40 px-2 py-1.5 text-sm font-medium [&::-webkit-details-marker]:hidden"
        )}
      >
        <div className="flex items-center gap-1">
          <ChevronDown className="size-4 text-muted-foreground transition-transform group-[:not([open])]:-rotate-90" />
          {group.name}
        </div>
        <div className="text-right text-xs text-muted-foreground tabular-nums">
          {formatMoney(totals.assigned)}
        </div>
        <div className="text-right text-xs text-muted-foreground tabular-nums">
          {formatMoney(totals.activity)}
        </div>
        <div className="text-right text-xs text-muted-foreground tabular-nums">
          {formatMoney(totals.available)}
        </div>
      </summary>

      <div className="divide-y divide-border/60">
        {group.categories.map((category) => (
          <Row
            key={category.id}
            category={category}
            allGroups={allGroups}
            month={month}
            currency={currency}
          />
        ))}
      </div>
    </details>
  );
}

function Row({
  category,
  allGroups,
  month,
  currency,
}: {
  category: CategoryView;
  allGroups: GroupView[];
  month: string;
  currency: string;
}) {
  const underfunded = category.goal != null && !category.goal.met;

  return (
    <div className={cn(GRID, "px-2 py-0.5", underfunded && "bg-amber-50")}>
      <div className="flex min-w-0 items-center justify-between gap-2 pr-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm">{category.name}</span>
          {category.avgSpend != null && (
            <span
              className="shrink-0 text-xs tabular-nums text-muted-foreground/50"
              title={`Average spent over the last 6 months: ${formatCurrency(category.avgSpend, currency)}`}
            >
              ø {currency} {formatMoneyWhole(category.avgSpend)}
            </span>
          )}
        </div>
        <GoalControl
          month={month}
          categoryId={category.id}
          monthlyTarget={category.monthlyTarget}
          goalMet={category.goal?.met ?? false}
          remaining={category.goal?.remaining ?? 0}
          funded={category.goalFunded}
        />
      </div>
      <AssignCell month={month} categoryId={category.id} assigned={category.assigned} />
      <ActivityCell activity={category.activity} transactions={category.activityTransactions} />
      <div className="flex justify-end pr-1">
        <AvailablePill
          month={month}
          categoryId={category.id}
          available={category.available}
          groups={allGroups}
        />
      </div>
    </div>
  );
}

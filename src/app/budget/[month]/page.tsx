import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { prevMonthKey, nextMonthKey } from "@/lib/budget-math";
import { formatCurrency, formatMoney } from "@/lib/currency";
import {
  currentMonth,
  getBudgetView,
  type CategoryView,
  type GroupView,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AssignCell } from "./assign-cell";
import { GoalControl } from "./goal-control";

const GRID = "grid grid-cols-[minmax(12rem,1fr)_7.5rem_7.5rem_8.5rem] items-center gap-x-2";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthLabel(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return `${MONTH_NAMES[mon - 1]} ${year}`;
}

function availableClass(value: number): string {
  if (value > 0) return "bg-emerald-100 text-emerald-700";
  if (value < 0) return "bg-red-100 text-red-700";
  return "bg-muted text-muted-foreground";
}

export default async function BudgetPage({
  params,
}: {
  params: Promise<{ month: string }>;
}) {
  const { month } = await params;
  if (!/^\d{4}-\d{2}$/.test(month)) notFound();

  const view = getBudgetView(month);
  const first = view.months[0];
  const last = view.months[view.months.length - 1];
  const hasPrev = month > first;
  const hasNext = month < last;
  const today = currentMonth();

  return (
    <div className="flex flex-1 flex-col">
      <Header
        month={month}
        hasPrev={hasPrev}
        hasNext={hasNext}
        today={today}
        readyToAssign={view.readyToAssign}
        totalUnderfunded={view.totalUnderfunded}
        currency={view.currency}
      />

      <div className="px-4 py-3">
        <div className={cn(GRID, "px-2 pb-1.5 text-xs font-medium text-muted-foreground uppercase")}>
          <div>Category</div>
          <div className="text-right">Assigned</div>
          <div className="text-right">Activity</div>
          <div className="text-right">Available</div>
        </div>

        <div className="divide-y divide-border rounded-lg border border-border">
          {view.groups.map((group) => (
            <Group key={group.id} group={group} month={month} />
          ))}
          {view.groups.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No categories yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Header({
  month,
  hasPrev,
  hasNext,
  today,
  readyToAssign,
  totalUnderfunded,
  currency,
}: {
  month: string;
  hasPrev: boolean;
  hasNext: boolean;
  today: string;
  readyToAssign: number;
  totalUnderfunded: number;
  currency: string;
}) {
  const rtaClass =
    readyToAssign > 0
      ? "text-emerald-600"
      : readyToAssign < 0
        ? "text-red-600"
        : "text-muted-foreground";

  return (
    <header className="flex items-end justify-between gap-6 border-b border-border px-4 py-3">
      <div className="flex items-center gap-1">
        <NavArrow to={hasPrev ? prevMonthKey(month) : null} label="Previous month">
          <ChevronLeft className="size-4" />
        </NavArrow>
        <div className="min-w-40 text-center text-sm font-semibold">{monthLabel(month)}</div>
        <NavArrow to={hasNext ? nextMonthKey(month) : null} label="Next month">
          <ChevronRight className="size-4" />
        </NavArrow>
        {month !== today && (
          <Link
            href={`/budget/${today}`}
            className="ml-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Today
          </Link>
        )}
      </div>

      <div className="text-right">
        <div className={cn("text-2xl font-semibold tabular-nums", rtaClass)}>
          {formatCurrency(readyToAssign, currency)}
        </div>
        <div className="text-xs text-muted-foreground">Ready to Assign</div>
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
  to,
  label,
  children,
}: {
  to: string | null;
  label: string;
  children: React.ReactNode;
}) {
  if (!to) {
    return (
      <span className="flex size-7 items-center justify-center rounded-md text-muted-foreground/40">
        {children}
      </span>
    );
  }
  return (
    <Link
      href={`/budget/${to}`}
      aria-label={label}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {children}
    </Link>
  );
}

function Group({ group, month }: { group: GroupView; month: string }) {
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
          <Row key={category.id} category={category} month={month} />
        ))}
      </div>
    </details>
  );
}

function Row({ category, month }: { category: CategoryView; month: string }) {
  const underfunded = category.goal != null && !category.goal.met;

  return (
    <div className={cn(GRID, "px-2 py-1", underfunded && "bg-amber-50")}>
      <div className="flex min-w-0 items-center justify-between gap-2 pr-2">
        <span className="truncate text-sm">{category.name}</span>
        <GoalControl
          month={month}
          categoryId={category.id}
          monthlyTarget={category.monthlyTarget}
          goalMet={category.goal?.met ?? false}
          remaining={category.goal?.remaining ?? 0}
        />
      </div>
      <AssignCell month={month} categoryId={category.id} assigned={category.assigned} />
      <div className="pr-2 text-right text-sm text-muted-foreground tabular-nums">
        {formatMoney(category.activity)}
      </div>
      <div className="flex justify-end pr-1">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-right text-sm tabular-nums",
            availableClass(category.available)
          )}
        >
          {formatMoney(category.available)}
        </span>
      </div>
    </div>
  );
}

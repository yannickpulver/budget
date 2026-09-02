import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/db";
import { formatCurrency, formatCurrencyWhole } from "@/lib/currency";
import { barWidth } from "@/lib/stats-format";
import {
  CHRONIC_WINDOW_MONTHS,
  getAssignedVsSpent,
  getChronicCategories,
  isOverspent,
  type AssignedVsSpent,
  type CategoryBudgetLine,
  type ChronicCategory,
  type GroupBudgetLines,
} from "@/lib/stats-budget-queries";
import { parseStatsPeriod, type StatsPeriod } from "@/lib/stats-period";
import { cn } from "@/lib/utils";
import { buildPeriodNav, EmptyNote, Section, StatsPage, StatTile } from "../ui";
import { PeriodNav } from "@/components/period-nav";

export const metadata: Metadata = { title: "Budget stats · budget" };

function budgetHref(period: StatsPeriod): string {
  return `/stats/budget?${new URLSearchParams({ period }).toString()}`;
}

function categoryHref(categoryId: number, period: StatsPeriod): string {
  return `/stats/categories?${new URLSearchParams({ cat: String(categoryId), period }).toString()}`;
}

export default async function BudgetStatsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: periodParam } = await searchParams;
  const now = new Date();
  const period = parseStatsPeriod(periodParam, now);

  const data = getAssignedVsSpent(period, db, now);
  const chronic = getChronicCategories(db, now);
  const nav = buildPeriodNav(period, now, budgetHref);

  return (
    <StatsPage active="budget" period={period} controls={<PeriodNav {...nav} />}>
      {data.assigned === 0 && data.spent === 0 ? (
        <EmptyNote>
          Nothing assigned or spent in this period. This tab compares what you assigned in the
          budget against what the envelopes actually cost, so it needs a month with assignments.
        </EmptyNote>
      ) : (
        <>
          <SummaryTiles data={data} />
          {data.groups.map((group) => (
            <GroupSection key={group.groupId} group={group} currency={data.currency} period={period} />
          ))}
          <WatchList over={chronic.over} under={chronic.under} currency={chronic.currency} period={period} />
        </>
      )}
    </StatsPage>
  );
}

function SummaryTiles({ data }: { data: AssignedVsSpent }) {
  const { currency } = data;
  const categoryCount = data.groups.reduce((sum, group) => sum + group.categories.length, 0);
  const leftOver = data.difference >= 0;

  return (
    <>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatTile label="Assigned" value={formatCurrency(data.assigned, currency)} />
        <StatTile label="Spent" value={formatCurrency(data.spent, currency)} />
        <StatTile
          label={leftOver ? "Left over" : "Overspent"}
          value={formatCurrency(Math.abs(data.difference), currency)}
          valueClassName={leftOver ? "text-emerald-600" : "text-red-600"}
        />
        <StatTile
          label="Categories over"
          value={String(data.overspentCount)}
          hint={`of ${categoryCount}`}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Spent is net category activity, as in the budget view: refunds reduce it and categorised
        transfers count.
      </p>
    </>
  );
}

function GroupSection({
  group,
  currency,
  period,
}: {
  group: GroupBudgetLines;
  currency: string;
  period: StatsPeriod;
}) {
  // One scale per group, so the rows inside it are comparable to each other
  // without a runaway category flattening every other group on the page.
  const scale = Math.max(
    1,
    ...group.categories.map((line) => Math.max(line.assigned, line.spent))
  );

  // "spent / assigned" only reads as a plan when the plan is a positive
  // number; a group whose assignments net out below zero is money moved back
  // out, and "/ CHF −800" invites the reader to do arithmetic that means
  // nothing. Clamp it and let the rows carry the detail.
  const caption = `${formatCurrency(group.spent, currency)} / ${formatCurrency(Math.max(group.assigned, 0), currency)}`;

  return (
    <Section title={group.name} caption={caption} className="mt-6">
      <div className="flex flex-col gap-2">
        {group.categories.map((line) => (
          <BudgetLineRow
            key={line.categoryId}
            line={line}
            scale={scale}
            currency={currency}
            period={period}
          />
        ))}
      </div>
    </Section>
  );
}

function BudgetLineRow({
  line,
  scale,
  currency,
  period,
}: {
  line: CategoryBudgetLine;
  scale: number;
  currency: string;
  period: StatsPeriod;
}) {
  const spentPct = barWidth(line.spent, scale);
  const assignedPct = barWidth(line.assigned, scale);
  // Assigned nothing but spent something: there is no tick to overshoot, so
  // the whole bar is the overspend.
  const unplanned = line.assigned <= 0 && line.spent > 0;
  const over = line.assigned > 0 && isOverspent(line);
  // A negative assignment is money moved back OUT of the category. There is no
  // envelope to draw, so the row states the movement in words instead of
  // pretending to a bar and a tick.
  const movedOut = line.assigned < 0;

  return (
    <Link
      href={categoryHref(line.categoryId, period)}
      className="-mx-1.5 block rounded-md px-1.5 py-1.5 hover:bg-muted"
    >
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="min-w-0 truncate">
          {line.name}
          {line.hidden && <span className="ml-1 text-xs text-muted-foreground">(hidden)</span>}
        </span>
        {movedOut ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatCurrency(line.spent, currency)} · {formatCurrencyWhole(-line.assigned, currency)} moved
            out
          </span>
        ) : (
          <span className="flex shrink-0 items-baseline gap-1">
            {line.ratio != null && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {Math.round(line.ratio * 100)}%
              </span>
            )}
            <span className="tabular-nums">{formatCurrency(line.spent, currency)}</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              / {formatCurrency(line.assigned, currency)}
            </span>
          </span>
        )}
      </div>

      {!movedOut && (
        <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("absolute inset-y-0 left-0", unplanned ? "bg-red-600" : "bg-foreground/70")}
            style={{ width: `${spentPct}%` }}
          />
          {over && (
            <div
              className="absolute inset-y-0 bg-red-600"
              style={{ left: `${assignedPct}%`, width: `${spentPct - assignedPct}%` }}
            />
          )}
          {!unplanned && line.assigned > 0 && (
            <div
              className="absolute inset-y-0 w-0.5 bg-foreground"
              style={{ left: `calc(${assignedPct}% - 1px)` }}
            />
          )}
        </div>
      )}
    </Link>
  );
}

function WatchList({
  over,
  under,
  currency,
  period,
}: {
  over: ChronicCategory[];
  under: ChronicCategory[];
  currency: string;
  period: StatsPeriod;
}) {
  if (over.length === 0 && under.length === 0) return null;

  return (
    <Section
      title="Watch list"
      caption={`Last ${CHRONIC_WINDOW_MONTHS} full months.`}
      className="mt-8"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <ChronicList
          heading="Often over"
          items={over}
          currency={currency}
          period={period}
          describe={(item) => `over in ${item.monthsHit} of ${item.monthsConsidered} months`}
        />
        <ChronicList
          heading="Often unused"
          items={under}
          currency={currency}
          period={period}
          describe={(item) => `under half used in ${item.monthsHit} of ${item.monthsConsidered} months`}
        />
      </div>
    </Section>
  );
}

function ChronicList({
  heading,
  items,
  currency,
  period,
  describe,
}: {
  heading: string;
  items: ChronicCategory[];
  currency: string;
  period: StatsPeriod;
  describe: (item: ChronicCategory) => string;
}) {
  if (items.length === 0) return null;

  return (
    <div>
      <h3 className="mb-2 text-xs font-medium text-muted-foreground uppercase">{heading}</h3>
      <div className="flex flex-col gap-1">
        {items.map((item) => (
          <Link
            key={item.categoryId}
            href={categoryHref(item.categoryId, period)}
            className="-mx-1.5 flex items-baseline justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-muted"
          >
            <span className="min-w-0">
              <span className="truncate text-sm">{item.name}</span>
              <span className="ml-1.5 text-xs text-muted-foreground">{item.groupName}</span>
              <span className="block text-xs text-muted-foreground">{describe(item)}</span>
            </span>
            <span className="shrink-0 text-sm tabular-nums">
              {formatCurrency(item.averageGap, currency)}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

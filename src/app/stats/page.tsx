import type { Metadata } from "next";
import { BarChart3 } from "lucide-react";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { BarList } from "@/components/charts/bar-list";
import { GroupedBarChart } from "@/components/charts/grouped-bar-chart";
import { LineChart } from "@/components/charts/line-chart";
import { CHART_COLORS } from "@/components/charts/theme";
import { PeriodNav } from "@/components/period-nav";
import { formatCurrency, formatCurrencyWhole } from "@/lib/currency";
import {
  monthAxisLabel,
  monthShortLabel,
  parseStatsPeriod,
  periodMode,
  statsPeriodLabel,
  type StatsPeriod,
} from "@/lib/stats-period";
import {
  getMonthlyCashflow,
  getNetWorthHistory,
  getSpendingByGroup,
  getTopPayees,
  type NetWorthPoint,
} from "@/lib/stats-queries";
import { cn } from "@/lib/utils";
import { StatsTabs } from "./tabs";
import { buildPeriodNav, EmptyNote, SectionHeading, StatsHeader, Tile } from "./ui";

export const metadata: Metadata = { title: "Stats · budget" };

const TOP_PAYEE_LIMIT = 10;

function overviewHref(period: StatsPeriod): string {
  return `/stats?period=${period}`;
}

export default async function StatsOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; cat?: string }>;
}) {
  const { period: periodParam, cat } = await searchParams;
  // One clock for the whole request so every section agrees on "today".
  const now = new Date();
  const period = parseStatsPeriod(periodParam, now);

  // Old /stats?cat=<id> links used to show the category drill-down; that now
  // lives at /stats/categories.
  if (cat != null) {
    redirect(`/stats/categories?${new URLSearchParams({ cat, period }).toString()}`);
  }

  const netWorth = getNetWorthHistory(db, now);
  const cashflow = getMonthlyCashflow(period, db, now);
  const spending = getSpendingByGroup(period, db);
  const payees = getTopPayees(period, TOP_PAYEE_LIMIT, db);

  const nav = buildPeriodNav(period, now, overviewHref);

  if (netWorth.points.length === 0) {
    return (
      <div className="flex flex-1 flex-col">
        <StatsHeader icon={<BarChart3 className="size-5 text-muted-foreground" />} title="Stats" />
        <StatsTabs active="overview" period={period} />
        <div className="px-4 py-4">
          <EmptyStatePanel />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <StatsHeader icon={<BarChart3 className="size-5 text-muted-foreground" />} title="Stats" />
      <StatsTabs active="overview" period={period} />

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <PeriodNav {...nav} />
      </div>

      <div className="flex flex-col gap-6 px-4 py-4">
        <NetWorthSection
          points={netWorth.points}
          currency={netWorth.currency}
          liveValuation={netWorth.liveValuation}
          period={period}
        />

        <CashflowSection cashflow={cashflow} period={period} />

        <div className="grid gap-6 lg:grid-cols-2">
          <section>
            <SectionHeading>Spending by group</SectionHeading>
            {spending.groups.length === 0 ? (
              <EmptyNote>No spending in {statsPeriodLabel(period).toLowerCase()}.</EmptyNote>
            ) : (
              <BarList
                items={spending.groups.map((group) => ({
                  key: String(group.groupId),
                  label: group.name,
                  value: group.outflow,
                  hint: `${formatShare(group.share)} · ${group.count}×`,
                }))}
                formatValue={(value) => formatCurrency(value, spending.currency)}
                colorClassName="bg-red-600/70"
              />
            )}
          </section>

          <section>
            <SectionHeading>Top payees</SectionHeading>
            {payees.length === 0 ? (
              <EmptyNote>No payees with spending in {statsPeriodLabel(period).toLowerCase()}.</EmptyNote>
            ) : (
              <BarList
                items={payees.map((payee, index) => ({
                  key: `${index}-${payee.payee}`,
                  label: payee.payee,
                  value: payee.outflow,
                  hint: `${payee.count}×`,
                }))}
                formatValue={(value) => formatCurrency(value, cashflow.currency)}
              />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** 0.184 -> "18%". */
function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** 0.184 -> "18%", null -> "—". */
function formatRate(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

function signClass(value: number): string {
  return value > 0 ? "text-emerald-600" : value < 0 ? "text-red-600" : "";
}

/**
 * Net-worth movement across the selected period: the last point inside the
 * period against the point just before it (0 when the period opens the
 * history — net worth genuinely started at nothing). Falls back to the last 12
 * points when the period holds no data at all, so the hero always says
 * something true.
 */
function netWorthChange(
  points: NetWorthPoint[],
  period: StatsPeriod
): { delta: number; caption: string } | null {
  if (points.length < 2) return null;
  const mode = periodMode(period);

  if (mode === "all") {
    return {
      delta: points[points.length - 1].balance - points[0].balance,
      caption: `since ${monthShortLabel(points[0].month)}`,
    };
  }

  const matches = (month: string) => (mode === "month" ? month === period : month.slice(0, 4) === period);
  const firstIndex = points.findIndex((p) => matches(p.month));

  if (firstIndex === -1) {
    const baseIndex = Math.max(0, points.length - 13);
    const months = points.length - 1 - baseIndex;
    return {
      delta: points[points.length - 1].balance - points[baseIndex].balance,
      caption: months === 1 ? "over the last month" : `over the last ${months} months`,
    };
  }

  let lastIndex = firstIndex;
  while (lastIndex + 1 < points.length && matches(points[lastIndex + 1].month)) lastIndex++;
  const baseline = firstIndex > 0 ? points[firstIndex - 1].balance : 0;

  return {
    delta: points[lastIndex].balance - baseline,
    caption: `over ${statsPeriodLabel(period)}`,
  };
}

function NetWorthSection({
  points,
  currency,
  liveValuation,
  period,
}: {
  points: NetWorthPoint[];
  currency: string;
  liveValuation: boolean;
  period: StatsPeriod;
}) {
  const current = points[points.length - 1].balance;
  const change = netWorthChange(points, period);

  return (
    <section>
      <SectionHeading>Net worth</SectionHeading>
      <div className="rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-3xl font-semibold tabular-nums">{formatCurrency(current, currency)}</span>
          {change != null && (
            <span className={cn("text-sm font-medium tabular-nums", signClass(change.delta))}>
              {change.delta >= 0 ? "+" : "−"}
              {formatCurrency(Math.abs(change.delta), currency)}
              <span className="ml-1 font-normal text-muted-foreground">{change.caption}</span>
            </span>
          )}
        </div>

        <LineChart
          className="mt-3"
          points={points.map((point) => ({
            key: point.month,
            label: monthAxisLabel(point.month),
            value: point.balance,
          }))}
          title="Net worth over time"
          formatValue={(value) => formatCurrencyWhole(value, currency)}
          height={200}
        />

        <p className="mt-2 text-xs text-muted-foreground">
          Always the full history, not the selected period.
          {liveValuation && " Investments are marked to their latest cached price."}
        </p>
      </div>
    </section>
  );
}

function CashflowSection({
  cashflow,
  period,
}: {
  cashflow: ReturnType<typeof getMonthlyCashflow>;
  period: StatsPeriod;
}) {
  const { currency } = cashflow;
  const hasActivity = cashflow.entries.some((entry) => entry.income > 0 || entry.spending > 0);

  return (
    <section>
      <SectionHeading>Income vs spending</SectionHeading>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="Income" value={formatCurrency(cashflow.income, currency)} />
        <Tile label="Spending" value={formatCurrency(cashflow.spending, currency)} />
        <Tile
          label="Net"
          value={formatCurrency(cashflow.net, currency)}
          valueClassName={signClass(cashflow.net)}
        />
        <Tile
          label="Savings rate"
          value={formatRate(cashflow.savingsRate)}
          hint={cashflow.savingsRate == null ? "no income" : undefined}
          valueClassName={cashflow.savingsRate == null ? "" : signClass(cashflow.savingsRate)}
        />
        <Tile
          label="Avg spending / mo"
          value={formatCurrency(cashflow.avgSpendingPerMonth, currency)}
          hint={statsPeriodLabel(period)}
        />
      </div>

      {hasActivity ? (
        <GroupedBarChart
          className="mt-3"
          bars={cashflow.entries.map((entry) => ({
            key: entry.key,
            label: entry.label,
            values: [entry.income, entry.spending],
            muted: !entry.inPeriod,
          }))}
          series={[
            { name: "Income", color: CHART_COLORS.income },
            { name: "Spending", color: CHART_COLORS.spending },
          ]}
          title={cashflow.bucket === "year" ? "Income vs spending per year" : "Income vs spending per month"}
          formatValue={(value) => formatCurrencyWhole(value, currency)}
          height={220}
        />
      ) : (
        <EmptyNote className="mt-3">No income or spending in {statsPeriodLabel(period).toLowerCase()}.</EmptyNote>
      )}

      {cashflow.entries.some((entry) => !entry.inPeriod) && (
        <p className="mt-2 text-xs text-muted-foreground">
          Faded months are context around {statsPeriodLabel(period)}.
        </p>
      )}
    </section>
  );
}

function EmptyStatePanel() {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-dashed border-border p-8 text-center">
      <BarChart3 className="mx-auto size-6 text-muted-foreground" />
      <h2 className="mt-3 text-sm font-semibold">Nothing to show yet</h2>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Import or add some transactions, then come back to see your net worth, cashflow and where the
        money goes.
      </p>
    </div>
  );
}

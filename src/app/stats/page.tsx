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
import { getPayeeIconMap } from "@/lib/payee-icons";
import {
  comparisonLabel,
  comparisonPeriod,
  monthAxisLabel,
  monthKeyOf,
  parseStatsPeriod,
  periodMode,
  statsPeriodLabel,
  type StatsPeriod,
} from "@/lib/stats-period";
import {
  delta,
  getLargestTransactions,
  getMonthlyCashflow,
  getNetWorthHistory,
  getSpendingByGroup,
  getTopPayees,
  netWorthAt,
} from "@/lib/stats-queries";
import { LargestTransactions } from "./largest-transactions";
import { SpendingGroups } from "./spending-groups";
import { buildPeriodNav, EmptyNote, Section, StatsPage, StatTile, type StatDelta } from "./ui";

export const metadata: Metadata = { title: "Stats · budget" };

const TOP_PAYEE_LIMIT = 10;
const LARGEST_LIMIT = 8;
/** How many net-worth points the tile's sparkline shows. */
const NET_WORTH_SPARK_MONTHS = 12;

function overviewHref(period: StatsPeriod): string {
  return `/stats?period=${period}`;
}

/** 0.184 -> "18%", null -> "—". */
function formatRate(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

function signClass(value: number): string {
  return value > 0 ? "text-emerald-600" : value < 0 ? "text-red-600" : "";
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
  const spending = getSpendingByGroup(period, db, now);
  const payees = getTopPayees(period, TOP_PAYEE_LIMIT, db);
  const largest = getLargestTransactions(period, LARGEST_LIMIT, db, now);
  const payeeIcons = getPayeeIconMap(db);

  if (netWorth.points.length === 0) {
    return (
      <StatsPage active="overview" period={period}>
        <EmptyStatePanel />
      </StatsPage>
    );
  }

  const nav = buildPeriodNav(period, now, overviewHref);
  const { currency } = cashflow;
  const previous = cashflow.previous;
  const compareLabel = comparisonLabel(period, now);
  const mode = periodMode(period);

  // A comparison needs both a previous total and a label for it; "all time" has
  // neither, and then the per-month average is the honest thing to show instead.
  const makeDelta = (
    current: number,
    prev: number | undefined,
    tone: StatDelta["tone"]
  ): StatDelta | null => {
    if (prev == null || compareLabel == null) return null;
    const d = delta(current, prev);
    return { change: d.change, percent: d.percent, currency, label: compareLabel, tone };
  };

  // The cashflow query already counts the months it summed, so the per-month
  // hints divide by that rather than by the length of an unrelated series.
  const perMonth = (total: number) =>
    cashflow.months > 0 ? `${formatCurrencyWhole(Math.round(total / cashflow.months), currency)} / mo` : undefined;

  const soFar = mode === "year" ? "so far this year" : "so far this month";
  const flowHint = (total: number) =>
    cashflow.partial ? soFar : previous == null ? perMonth(total) : undefined;

  // Net worth is a stock, not a flow: the tile shows the balance as it stood at
  // the END of the selected period (not today's, which would sit above a delta
  // measured somewhere else entirely), and compares it against the balance at
  // the end of the comparison period's last month rather than against a sum.
  const latestMonth = netWorth.points[netWorth.points.length - 1].month;
  const nowMonth = monthKeyOf(now);
  const periodEndMonth =
    mode === "all" ? latestMonth : mode === "year" ? (period === nowMonth.slice(0, 4) ? nowMonth : `${period}-12`) : period;
  const currentNetWorth =
    netWorthAt(netWorth.points, periodEndMonth) ?? netWorth.points[netWorth.points.length - 1].balance;
  const netWorthSpark = netWorth.points
    .filter((point) => point.month <= periodEndMonth)
    .slice(-NET_WORTH_SPARK_MONTHS)
    .map((point) => point.balance);
  const comparison = comparisonPeriod(period);
  const comparisonEndMonth = comparison == null ? null : mode === "year" ? `${comparison}-12` : comparison;
  const previousNetWorth =
    comparisonEndMonth == null ? null : netWorthAt(netWorth.points, comparisonEndMonth);

  return (
    <StatsPage active="overview" period={period} controls={<PeriodNav {...nav} />}>
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <StatTile
            label="Spending"
            value={formatCurrencyWhole(cashflow.spending, currency)}
            delta={makeDelta(cashflow.spending, previous?.spending, "down-good")}
            hint={
              cashflow.partial
                ? soFar
                : previous == null
                  ? `${formatCurrencyWhole(cashflow.avgSpendingPerMonth, currency)} / mo`
                  : undefined
            }
            sparkline={cashflow.trailing.spending}
          />
          <StatTile
            label="Income"
            value={formatCurrencyWhole(cashflow.income, currency)}
            delta={makeDelta(cashflow.income, previous?.income, "up-good")}
            hint={flowHint(cashflow.income)}
            sparkline={cashflow.trailing.income}
          />
          <StatTile
            label="Net"
            value={formatCurrencyWhole(cashflow.net, currency)}
            valueClassName={signClass(cashflow.net)}
            delta={makeDelta(cashflow.net, previous?.net, "up-good")}
            hint={
              cashflow.savingsRate == null
                ? "no income"
                : `savings rate ${formatRate(cashflow.savingsRate)}`
            }
            sparkline={cashflow.trailing.net}
          />
          <StatTile
            label="Net worth"
            value={formatCurrencyWhole(currentNetWorth, currency)}
            delta={
              previousNetWorth == null
                ? null
                : makeDelta(currentNetWorth, previousNetWorth, "neutral")
            }
            hint={netWorth.liveValuation ? "investments at latest price" : undefined}
            sparkline={netWorthSpark}
          />
        </div>

        <CashflowSection cashflow={cashflow} period={period} />

        <div className="grid gap-6 lg:grid-cols-2">
          <Section
            title="Spending by group"
            caption={spending.total > 0 ? formatCurrency(spending.total, spending.currency) : undefined}
          >
            {spending.groups.length === 0 ? (
              <EmptyNote>No spending in {statsPeriodLabel(period)}.</EmptyNote>
            ) : (
              <SpendingGroups
                groups={spending.groups}
                currency={spending.currency}
                period={period}
                comparisonLabel={compareLabel}
              />
            )}
          </Section>

          <Section title="Largest transactions">
            {largest.rows.length === 0 ? (
              <EmptyNote>No purchases in {statsPeriodLabel(period)}.</EmptyNote>
            ) : (
              <LargestTransactions
                rows={largest.rows}
                currency={largest.currency}
                iconUrls={payeeIcons}
              />
            )}
          </Section>
        </div>

        <Section title="Top payees">
          {payees.length === 0 ? (
            <EmptyNote>No payees with spending in {statsPeriodLabel(period)}.</EmptyNote>
          ) : (
            <BarList
              items={payees.map((payee, index) => ({
                key: `${index}-${payee.payee}`,
                label: payee.payee,
                value: payee.outflow,
                hint: `${payee.count}×`,
              }))}
              formatValue={(value) => formatCurrency(value, currency)}
            />
          )}
        </Section>

        <Section title="Net worth">
          <LineChart
            points={netWorth.points.map((point) => ({
              key: point.month,
              label: monthAxisLabel(point.month),
              value: point.balance,
            }))}
            title="Net worth over time"
            currency={netWorth.currency}
            height={200}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Always the full history, not the selected period.
            {netWorth.liveValuation && " Investments are marked to their latest cached price."}
          </p>
        </Section>
      </div>
    </StatsPage>
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

  const bars = cashflow.entries.map((entry) => ({
    key: entry.key,
    label: entry.label,
    values: [entry.income, entry.spending],
    muted: !entry.inPeriod,
  }));
  const series = [
    { name: "Income", color: CHART_COLORS.income },
    { name: "Spending", color: CHART_COLORS.spending },
  ];
  const title = cashflow.bucket === "year" ? "Income vs spending per year" : "Income vs spending per month";

  return (
    <Section title="Income vs spending">
      {hasActivity ? (
        <>
          {/* One chart, two heights: a 220px plot eats too much of a phone
              screen. ChartFrame measures its rendered CSS height, so the
              breakpoint lives in the class list; `height` is the fallback
              used before the first measurement. */}
          <GroupedBarChart
            className="h-45 sm:h-55"
            bars={bars}
            series={series}
            title={title}
            currency={currency}
            height={220}
          />
        </>
      ) : (
        <EmptyNote>No income or spending in {statsPeriodLabel(period)}.</EmptyNote>
      )}

      {cashflow.entries.some((entry) => !entry.inPeriod) && (
        <p className="mt-2 text-xs text-muted-foreground">
          Faded months are context around {statsPeriodLabel(period)}.
        </p>
      )}
    </Section>
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

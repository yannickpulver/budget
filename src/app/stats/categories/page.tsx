import type { Metadata } from "next";
import { db } from "@/db";
import { BarList } from "@/components/charts/bar-list";
import { GroupedBarChart } from "@/components/charts/grouped-bar-chart";
import { CHART_COLORS } from "@/components/charts/theme";
import { PeriodNav } from "@/components/period-nav";
import { formatCurrency, formatCurrencyWhole } from "@/lib/currency";
import { getCategoryStats, listCategoryGroupsAdmin, type CategoryStats } from "@/lib/queries";
import { delta, getCategoryOutflowBetween } from "@/lib/stats-queries";
import {
  comparisonBounds,
  comparisonLabel,
  currentBounds,
  monthAxisLabel,
  monthKeyOf,
  monthKeysBetween,
  parseStatsPeriod,
  periodMode,
  statsPeriodLabel,
  type StatsPeriod,
} from "@/lib/stats-period";
import { CategoryPicker } from "../category-picker";
import { buildPeriodNav, EmptyNote, Section, StatsPage, StatTile, type StatDelta } from "../ui";

export const metadata: Metadata = { title: "Category stats · budget" };

function categoriesHref(cat: string, period: StatsPeriod): string {
  return `/stats/categories?${new URLSearchParams({ cat, period }).toString()}`;
}

export default async function CategoryStatsPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; period?: string }>;
}) {
  const { cat, period: periodParam } = await searchParams;
  const now = new Date();
  const period = parseStatsPeriod(periodParam, now);

  const groups = listCategoryGroupsAdmin(db).filter((group) => group.categories.length > 0);
  const allCategories = groups.flatMap((group) => group.categories);

  if (allCategories.length === 0) {
    return (
      <StatsPage active="categories" period={period}>
        <EmptyNote>
          No categories yet. Add a few categories and some transactions, then come back to see how
          much goes into each.
        </EmptyNote>
      </StatsPage>
    );
  }

  // Resolve the selection. Default (no/`all`/unknown `cat`) aggregates across
  // all categories; a numeric `cat` that matches a real category selects it.
  const requested = cat != null && cat !== "all" ? Number(cat) : NaN;
  const known = new Set(allCategories.map((c) => c.id));
  const selectedId = Number.isInteger(requested) && known.has(requested) ? requested : null;
  const selectedValue = selectedId == null ? "all" : String(selectedId);
  const selected = selectedId == null ? null : allCategories.find((c) => c.id === selectedId)!;

  const stats = getCategoryStats(selectedId, period, db, now);
  const nav = buildPeriodNav(period, now, (next) => categoriesHref(selectedValue, next));

  // Month-to-date-fair comparison: `comparisonBounds` cuts the previous period
  // at the same day-of-month while this one is still running, and
  // `comparisonLabel` says "so far" for exactly that case.
  const compare = comparisonBounds(period, now);
  const previousOutflow =
    compare == null ? null : getCategoryOutflowBetween(selectedId, compare.start, compare.end, db);
  const compareLabel = comparisonLabel(period, now);
  // Both sides of the comparison have to cover the same stretch of days, so a
  // running period's own figure is cut at today too — `stats.totalOutflow`
  // spans the whole calendar month/year and would beat a "so far" figure for
  // no reason.
  const current = currentBounds(period, now);
  const currentOutflow =
    current != null && current.partial
      ? getCategoryOutflowBetween(selectedId, current.start, current.end, db)
      : stats.totalOutflow;
  const spentDelta: StatDelta | null =
    previousOutflow == null || compareLabel == null
      ? null
      : {
          ...delta(currentOutflow, previousOutflow),
          currency: stats.currency,
          label: compareLabel,
          tone: "down-good",
        };

  // Same period one year earlier, per month — the ghost behind the trend
  // columns. Only meaningful for a year view; "all" has no single prior year.
  const ghostByMonth =
    periodMode(period) === "year"
      ? new Map(
          getCategoryStats(selectedId, String(Number(period) - 1), db, now).buckets.map(
            (bucket) => [bucket.key.slice(5), bucket.outflow] as const
          )
        )
      : null;

  // The x-axis of a year's trend is the year's months, not the months that
  // happen to have activity: zero-filling keeps the columns aligned with the
  // ghost behind them, and a month that only last year had spend still shows
  // its ghost instead of vanishing from the axis. A running year stops at the
  // current month rather than drawing empty columns into the future.
  const nowMonth = monthKeyOf(now);
  const trendMonths =
    periodMode(period) === "year"
      ? monthKeysBetween(`${period}-01`, period === nowMonth.slice(0, 4) ? nowMonth : `${period}-12`)
      : null;

  return (
    <StatsPage
      active="categories"
      period={period}
      cat={selectedValue}
      controls={
        <>
          {/* Full width on a phone: the native select grows to its longest
              option, which is what pushed the page into horizontal scroll. */}
          <div className="w-full sm:w-auto">
            <CategoryPicker groups={groups} selected={selectedValue} period={period} />
          </div>
          <PeriodNav {...nav} />
        </>
      }
    >
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-lg font-semibold">
          {selected == null ? "All categories" : selected.name}
          {selected?.hiddenFrom != null && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">(hidden)</span>
          )}
        </h2>
        <span className="text-xs text-muted-foreground">{statsPeriodLabel(period)}</span>
      </div>

      <SummaryTiles stats={stats} spentDelta={spentDelta} />

      <Trend stats={stats} ghostByMonth={ghostByMonth} months={trendMonths} />

      <Breakdown stats={stats} period={period} cat={selectedValue} />
    </StatsPage>
  );
}

function SummaryTiles({ stats, spentDelta }: { stats: CategoryStats; spentDelta: StatDelta | null }) {
  const { currency } = stats;
  const tiles: { label: string; value: string; hint?: string; delta?: StatDelta | null }[] = [
    { label: "Spent", value: formatCurrencyWhole(stats.totalOutflow, currency), delta: spentDelta },
    {
      label: "Transactions",
      value: String(stats.count),
      hint: stats.totalInflow > 0 ? `+${formatCurrency(stats.totalInflow, currency)} in` : undefined,
    },
  ];
  if (periodMode(stats.period) !== "month") {
    tiles.push({
      label: "Avg / month",
      value: formatCurrencyWhole(stats.avgOutflowPerMonth, currency),
      hint: stats.monthsElapsed > 0 ? `over ${stats.monthsElapsed} mo` : undefined,
    });
  }
  if (stats.totalInflow > 0) {
    tiles.push({ label: "Net spent", value: formatCurrencyWhole(stats.net, currency) });
  }

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {tiles.map((tile) => (
        <StatTile
          key={tile.label}
          label={tile.label}
          value={tile.value}
          hint={tile.hint}
          delta={tile.delta}
        />
      ))}
    </div>
  );
}

/**
 * Monthly outflow as columns — only for year/all-time, where the buckets are
 * months and the shape over time is the story the bar list can't tell.
 */
function Trend({
  stats,
  ghostByMonth,
  months,
}: {
  stats: CategoryStats;
  ghostByMonth: Map<string, number> | null;
  /** Explicit x-axis (a year's months); null falls back to the months with activity. */
  months: string[] | null;
}) {
  if (periodMode(stats.period) === "month" || stats.bucketKind !== "month") return null;
  if (stats.buckets.length < 2) return null;

  const outflowByMonth = new Map(stats.buckets.map((bucket) => [bucket.key, bucket.outflow] as const));
  const axis = months ?? stats.buckets.map((bucket) => bucket.key);

  return (
    <Section title="Monthly trend" className="mt-6">
      <GroupedBarChart
        bars={axis.map((month) => ({
          key: month,
          label: monthAxisLabel(month),
          values: [outflowByMonth.get(month) ?? 0],
          ghost: ghostByMonth == null ? undefined : [ghostByMonth.get(month.slice(5)) ?? 0],
        }))}
        series={[{ name: "Spent", color: CHART_COLORS.neutral }]}
        title="Spending per month"
        currency={stats.currency}
        ghostName="Year before"
        reference={{ label: "avg / mo", value: stats.avgOutflowPerMonth }}
        height={180}
      />
    </Section>
  );
}

function Breakdown({
  stats,
  period,
  cat,
}: {
  stats: CategoryStats;
  period: StatsPeriod;
  /** The currently selected category ("all" or an id) — kept when drilling into a month. */
  cat: string;
}) {
  if (stats.count === 0) {
    return (
      <EmptyNote className="mt-6">
        No transactions in {statsPeriodLabel(stats.period)}.
      </EmptyNote>
    );
  }

  const heading =
    stats.bucketKind === "month" ? "By month" : stats.bucketKind === "category" ? "By category" : "By payee";

  // Month buckets drill into that month; category buckets (all-categories in
  // month mode) select that category. Payee buckets have nowhere to go.
  const hrefFor = (key: string): string | undefined => {
    if (stats.bucketKind === "month") return categoriesHref(cat, key);
    if (stats.bucketKind === "category") return categoriesHref(key, period);
    return undefined;
  };

  return (
    <Section title={heading} className="mt-6">
      <BarList
        items={stats.buckets.map((bucket) => ({
          key: bucket.key,
          label: bucket.label,
          value: bucket.outflow,
          hint: `${bucket.count}×`,
          href: hrefFor(bucket.key),
        }))}
        formatValue={(value) => formatCurrency(value, stats.currency)}
      />
    </Section>
  );
}

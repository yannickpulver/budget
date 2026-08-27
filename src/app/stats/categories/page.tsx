import type { Metadata } from "next";
import { BarChart3 } from "lucide-react";
import { db } from "@/db";
import { BarList } from "@/components/charts/bar-list";
import { GroupedBarChart } from "@/components/charts/grouped-bar-chart";
import { CHART_COLORS } from "@/components/charts/theme";
import { PeriodNav } from "@/components/period-nav";
import { formatCurrency, formatCurrencyWhole } from "@/lib/currency";
import { getCategoryStats, listCategoryGroupsAdmin, type CategoryStats } from "@/lib/queries";
import {
  monthAxisLabel,
  parseStatsPeriod,
  periodMode,
  statsPeriodLabel,
  type StatsPeriod,
} from "@/lib/stats-period";
import { CategoryPicker } from "../category-picker";
import { StatsTabs } from "../tabs";
import { buildPeriodNav, EmptyNote, SectionHeading, StatsHeader, Tile } from "../ui";

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
      <div className="flex flex-1 flex-col">
        <StatsHeader icon={<BarChart3 className="size-5 text-muted-foreground" />} title="Stats" />
        <StatsTabs active="categories" period={period} />
        <div className="px-4 py-4">
          <EmptyNote>
            No categories yet. Add a few categories and some transactions, then come back to see how
            much goes into each.
          </EmptyNote>
        </div>
      </div>
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

  return (
    <div className="flex flex-1 flex-col">
      <StatsHeader icon={<BarChart3 className="size-5 text-muted-foreground" />} title="Stats" />
      <StatsTabs active="categories" period={period} cat={selectedValue} />

      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <CategoryPicker groups={groups} selected={selectedValue} period={period} />
        <PeriodNav {...nav} />
      </div>

      <div className="px-4 py-4">
        <div className="mb-1 flex items-baseline gap-2">
          <h2 className="text-lg font-semibold">
            {selected == null ? "All categories" : selected.name}
            {selected?.hiddenFrom != null && (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">(hidden)</span>
            )}
          </h2>
          <span className="text-xs text-muted-foreground">{statsPeriodLabel(period)}</span>
        </div>

        <SummaryTiles stats={stats} />

        <Trend stats={stats} />

        <Breakdown stats={stats} />
      </div>
    </div>
  );
}

function SummaryTiles({ stats }: { stats: CategoryStats }) {
  const { currency } = stats;
  const tiles: { label: string; value: string; hint?: string }[] = [
    { label: "Spent", value: formatCurrency(stats.totalOutflow, currency) },
    {
      label: "Transactions",
      value: String(stats.count),
      hint: stats.totalInflow > 0 ? `+${formatCurrency(stats.totalInflow, currency)} in` : undefined,
    },
  ];
  if (periodMode(stats.period) !== "month") {
    tiles.push({
      label: "Avg / month",
      value: formatCurrency(stats.avgOutflowPerMonth, currency),
      hint: stats.monthsElapsed > 0 ? `over ${stats.monthsElapsed} mo` : undefined,
    });
  }
  if (stats.totalInflow > 0) {
    tiles.push({ label: "Net spent", value: formatCurrency(stats.net, currency) });
  }

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map((tile) => (
        <Tile key={tile.label} label={tile.label} value={tile.value} hint={tile.hint} />
      ))}
    </div>
  );
}

/**
 * Monthly outflow as columns — only for year/all-time, where the buckets are
 * months and the shape over time is the story the bar list can't tell.
 */
function Trend({ stats }: { stats: CategoryStats }) {
  if (periodMode(stats.period) === "month" || stats.bucketKind !== "month") return null;
  if (stats.buckets.length < 2) return null;

  return (
    <div className="mt-5">
      <SectionHeading>Monthly trend</SectionHeading>
      <GroupedBarChart
        bars={stats.buckets.map((bucket) => ({
          key: bucket.key,
          label: monthAxisLabel(bucket.key),
          values: [bucket.outflow],
        }))}
        series={[{ name: "Spent", color: CHART_COLORS.neutral }]}
        title="Spending per month"
        formatValue={(value) => formatCurrencyWhole(value, stats.currency)}
        height={180}
      />
    </div>
  );
}

function Breakdown({ stats }: { stats: CategoryStats }) {
  if (stats.count === 0) {
    return <EmptyNote className="mt-6">No transactions in {statsPeriodLabel(stats.period).toLowerCase()}.</EmptyNote>;
  }

  const heading =
    stats.bucketKind === "month" ? "By month" : stats.bucketKind === "category" ? "By category" : "By payee";

  return (
    <div className="mt-5">
      <SectionHeading>{heading}</SectionHeading>
      <BarList
        items={stats.buckets.map((bucket) => ({
          key: bucket.key,
          label: bucket.label,
          value: bucket.outflow,
          hint: `${bucket.count}×`,
        }))}
        formatValue={(value) => formatCurrency(value, stats.currency)}
      />
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { BarChart3 } from "lucide-react";
import { db } from "@/db";
import { formatCurrency, formatMoney } from "@/lib/currency";
import {
  getCategoryStats,
  listCategoryGroupsAdmin,
  STATS_PERIODS,
  type CategoryStats,
  type StatsPeriod,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import { CategoryPicker } from "./category-picker";

export const metadata: Metadata = { title: "Stats · budget" };

const PERIOD_LABELS: Record<StatsPeriod, string> = {
  month: "This month",
  year: "This year",
  all: "All time",
};

function isStatsPeriod(value: string | undefined): value is StatsPeriod {
  return value != null && (STATS_PERIODS as readonly string[]).includes(value);
}

function statsHref(cat: string, period: StatsPeriod): string {
  return `/stats?cat=${cat}&period=${period}`;
}

export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; period?: string }>;
}) {
  const { cat, period: periodParam } = await searchParams;
  const period: StatsPeriod = isStatsPeriod(periodParam) ? periodParam : "month";

  const groups = listCategoryGroupsAdmin(db).filter((g) => g.categories.length > 0);
  const allCategories = groups.flatMap((g) => g.categories);

  if (allCategories.length === 0) {
    return (
      <div className="flex flex-1 flex-col">
        <Header />
        <div className="px-4 py-3">
          <EmptyState />
        </div>
      </div>
    );
  }

  // Resolve the selection. Default (no/`all`/unknown `cat`) aggregates across
  // all categories; a numeric `cat` that matches a real category selects it.
  const requested = cat != null && cat !== "all" ? Number(cat) : NaN;
  const known = new Set(allCategories.map((c) => c.id));
  const selectedId =
    Number.isInteger(requested) && known.has(requested) ? requested : null;
  const selectedValue = selectedId == null ? "all" : String(selectedId);
  const selected = selectedId == null ? null : allCategories.find((c) => c.id === selectedId)!;

  const stats = getCategoryStats(selectedId, period, db);

  return (
    <div className="flex flex-1 flex-col">
      <Header />

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <CategoryPicker groups={groups} selected={selectedValue} period={period} />
        <div className="flex items-center gap-1.5">
          {STATS_PERIODS.map((key) => (
            <Link
              key={key}
              href={statsHref(selectedValue, key)}
              className={cn(
                "inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium transition-colors",
                key === period
                  ? "border-transparent bg-foreground text-background hover:bg-foreground/90"
                  : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {PERIOD_LABELS[key]}
            </Link>
          ))}
        </div>
      </div>

      <div className="px-4 py-4">
        <div className="mb-1 flex items-baseline gap-2">
          <h2 className="text-lg font-semibold">
            {selected == null ? "All categories" : selected.name}
            {selected?.hidden && (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">(hidden)</span>
            )}
          </h2>
          <span className="text-xs text-muted-foreground">{PERIOD_LABELS[period].toLowerCase()}</span>
        </div>

        <SummaryTiles stats={stats} />

        <Breakdown stats={stats} />
      </div>
    </div>
  );
}

function Header() {
  return (
    <header className="flex items-center gap-2 border-b border-border px-4 py-3">
      <BarChart3 className="size-5 text-muted-foreground" />
      <h1 className="text-xl font-semibold">Stats</h1>
    </header>
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
  if (stats.period !== "month") {
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
        <div key={tile.label} className="rounded-lg border border-border p-3">
          <div className="text-xs font-medium text-muted-foreground uppercase">{tile.label}</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{tile.value}</div>
          {tile.hint && <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{tile.hint}</div>}
        </div>
      ))}
    </div>
  );
}

function Breakdown({ stats }: { stats: CategoryStats }) {
  if (stats.count === 0) {
    return (
      <p className="mt-6 rounded-lg border border-dashed border-border px-2 py-8 text-center text-sm text-muted-foreground">
        No transactions for {PERIOD_LABELS[stats.period].toLowerCase()}.
      </p>
    );
  }

  const max = Math.max(1, ...stats.buckets.map((b) => b.outflow));
  const heading =
    stats.bucketKind === "month"
      ? "By month"
      : stats.bucketKind === "category"
        ? "By category"
        : "By payee";

  return (
    <div className="mt-5">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground uppercase">{heading}</h3>
      <div className="flex flex-col gap-2">
        {stats.buckets.map((bucket) => (
          <div key={bucket.key}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">{bucket.label}</span>
              <span className="shrink-0 tabular-nums">{formatMoney(bucket.outflow)}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground/70"
                style={{ width: `${Math.max(2, (bucket.outflow / max) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-dashed border-border p-8 text-center">
      <BarChart3 className="mx-auto size-6 text-muted-foreground" />
      <h2 className="mt-3 text-sm font-semibold">Nothing to show yet</h2>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Add some categories and transactions, then come back to see how much you spend in each.
      </p>
    </div>
  );
}

import { BarChart3 } from "lucide-react";
import { Sparkline } from "@/components/charts/sparkline";
import { formatDelta, isNoChange } from "@/lib/stats-format";
import { cn } from "@/lib/utils";
import {
  currentPeriod,
  periodMode,
  shiftPeriod,
  statsPeriodLabel,
  type PeriodMode,
  type StatsPeriod,
} from "@/lib/stats-period";
import { StatsTabs, type StatsTab } from "./tabs";

/** Page header shared by every /stats route — icon + title, matching /budget. */
export function StatsHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <header className="flex items-center gap-2 border-b border-border px-4 py-3">
      {icon}
      <h1 className="text-xl font-semibold">{title}</h1>
    </header>
  );
}

/**
 * Whole-page chrome for every /stats route: header, tab row, an optional
 * controls strip (period nav, pickers) and the content container. Keeping it
 * in one place is what stops the four routes from drifting apart by a few
 * pixels of padding each.
 */
export function StatsPage({
  active,
  period,
  cat,
  controls,
  children,
}: {
  active: StatsTab;
  period: StatsPeriod;
  cat?: string;
  controls?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col">
      <StatsHeader icon={<BarChart3 className="size-5 text-muted-foreground" />} title="Stats" />
      <StatsTabs active={active} period={period} cat={cat} />

      {controls != null && (
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          {controls}
        </div>
      )}

      <div className="mx-auto w-full max-w-6xl px-4 py-4 md:px-6">{children}</div>
    </div>
  );
}

/** One number in a bordered box: uppercase label, big tabular value, optional hint. */
export function Tile({
  label,
  value,
  hint,
  valueClassName,
}: {
  label: string;
  value: string;
  hint?: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-xs font-medium text-muted-foreground uppercase">{label}</div>
      <div className={cn("mt-1 text-lg font-semibold tabular-nums", valueClassName)}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{hint}</div>}
    </div>
  );
}

/** Which direction of change is the good one, i.e. which sign wears emerald. */
export type DeltaTone = "up-good" | "down-good" | "neutral";

export interface StatDelta {
  /** Absolute change in Rappen (negative = went down). */
  change: number;
  /** Relative change, or null when the previous figure was too small to divide by. */
  percent: number | null;
  currency: string;
  /** What the comparison is against, e.g. "vs Jul so far". */
  label: string;
  tone: DeltaTone;
}

/** Emerald / red / plain ink for a change, given which direction counts as good. */
function deltaClass(change: number, tone: DeltaTone): string {
  if (tone === "neutral" || change === 0) return "";
  const good = tone === "up-good" ? change > 0 : change < 0;
  return good ? "text-emerald-600" : "text-red-600";
}

/**
 * The headline figures at the top of a stats page: a big proportional number
 * (large standalone values read better in proportional figures than in tabular
 * ones), the period-over-period movement below it, and an optional 32px
 * sparkline for the trailing shape. The sparkline is decorative — every value
 * it hints at is also stated in text.
 */
export function StatTile({
  label,
  value,
  delta = null,
  hint,
  sparkline,
  className,
  valueClassName,
}: {
  label: string;
  value: string;
  delta?: StatDelta | null;
  hint?: string;
  sparkline?: number[];
  className?: string;
  /** Merged into the big value line, e.g. a semantic emerald/red for a signed figure. */
  valueClassName?: string;
}): React.ReactElement {
  return (
    <div className={cn("rounded-lg border border-border p-3", className)}>
      <div className="text-xs font-medium text-muted-foreground uppercase">{label}</div>
      <div className={cn("mt-1 text-2xl leading-tight font-semibold", valueClassName)}>{value}</div>

      {delta != null && (
        <div className="mt-1 text-xs">
          {isNoChange(delta.change) ? (
            <span className="text-muted-foreground">no change {delta.label}</span>
          ) : (
            <>
              <span className={cn("font-medium", deltaClass(delta.change, delta.tone))}>
                {formatDelta(delta.change, delta.percent, delta.currency, { separator: "middot" })}
              </span>{" "}
              <span className="text-muted-foreground">{delta.label}</span>
            </>
          )}
        </div>
      )}

      {hint && <div className="mt-1 truncate text-xs text-muted-foreground">{hint}</div>}

      {sparkline != null && <Sparkline className="mt-2" points={sparkline} height={32} />}
    </div>
  );
}

/** Small uppercase section label. */
export function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 text-xs font-medium text-muted-foreground uppercase">{children}</h2>;
}

/** A titled block, optionally with a right-aligned caption on the heading row. */
export function Section({
  title,
  caption,
  children,
  className,
}: {
  title: string;
  caption?: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <section className={className}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-medium text-muted-foreground uppercase">{title}</h2>
        {caption && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{caption}</span>
        )}
      </div>
      {children}
    </section>
  );
}

/** Dashed placeholder used wherever a section has nothing to draw. */
export function EmptyNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "rounded-lg border border-dashed border-border px-2 py-8 text-center text-sm text-muted-foreground",
        className
      )}
    >
      {children}
    </p>
  );
}

const MODES: { key: PeriodMode; label: string }[] = [
  { key: "month", label: "Month" },
  { key: "year", label: "Year" },
  { key: "all", label: "All" },
];

/**
 * The period the Month/Year/All toggle should land on, keeping as much of the
 * current context as possible (March 2024 -> "2024" -> December 2024).
 */
function periodForMode(period: StatsPeriod, mode: PeriodMode, now: Date): StatsPeriod {
  const current = periodMode(period);
  if (mode === "all") return "all";
  if (mode === "year") {
    if (current === "month") return period.slice(0, 4);
    if (current === "year") return period;
    return currentPeriod("year", now);
  }
  if (current === "month") return period;
  if (current === "year") {
    return Number(period) === now.getFullYear() ? currentPeriod("month", now) : `${period}-12`;
  }
  return currentPeriod("month", now);
}

/**
 * Props for a `<PeriodNav>` driving `?period=`. `href` builds the destination
 * URL for a period so each page keeps its own path and extra search params.
 */
export function buildPeriodNav(
  period: StatsPeriod,
  now: Date,
  href: (period: StatsPeriod) => string
): {
  label: string;
  prevHref: string | null;
  nextHref: string | null;
  jumpHref: string | null;
  jumpLabel: string;
  modes: { key: string; label: string; href: string; active: boolean }[];
} {
  const mode = periodMode(period);
  const prev = shiftPeriod(period, -1, now);
  const next = shiftPeriod(period, 1, now);
  const nowPeriod = currentPeriod(mode, now);

  return {
    label: statsPeriodLabel(period),
    prevHref: prev == null ? null : href(prev),
    nextHref: next == null ? null : href(next),
    jumpHref: mode === "all" || period === nowPeriod ? null : href(nowPeriod),
    jumpLabel: mode === "year" ? "This year" : "This month",
    modes: MODES.map((m) => ({
      key: m.key,
      label: m.label,
      href: href(periodForMode(period, m.key, now)),
      active: m.key === mode,
    })),
  };
}

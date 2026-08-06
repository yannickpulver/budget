import { cn } from "@/lib/utils";
import {
  currentPeriod,
  periodMode,
  shiftPeriod,
  statsPeriodLabel,
  type PeriodMode,
  type StatsPeriod,
} from "@/lib/stats-period";

/** Page header shared by every /stats route — icon + title, matching /budget. */
export function StatsHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <header className="flex items-center gap-2 border-b border-border px-4 py-3">
      {icon}
      <h1 className="text-xl font-semibold">{title}</h1>
    </header>
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

/** Small uppercase section label. */
export function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 text-xs font-medium text-muted-foreground uppercase">{children}</h2>;
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

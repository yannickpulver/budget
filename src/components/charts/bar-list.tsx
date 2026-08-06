import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Horizontal bar list — the componentised version of the `Breakdown` rows on
 * the stats page. Each row is label-left/value-right (tabular-nums) over a
 * thin rounded track; the filled portion is the only "chart" ink, so the
 * form needs no legend and no axis. A single hue at a fixed proportional
 * width reads as magnitude at a glance without asking for a plot.
 *
 * Bars are scaled against the largest value (or an explicit `max`, e.g. to
 * keep two lists visually comparable) and always render at least 2% width
 * so a small-but-nonzero value stays visible instead of disappearing.
 */
export function BarList(props: {
  items: { key: string; label: string; value: number; hint?: string; href?: string }[];
  formatValue: (value: number) => string;
  /** Bar fill color class; defaults to a neutral `bg-foreground/70`. */
  colorClassName?: string;
  className?: string;
  /** Scale ceiling; defaults to the largest value among `items`. */
  max?: number;
}) {
  const { items, formatValue, colorClassName = "bg-foreground/70", className, max } = props;

  const ceiling = max ?? Math.max(1, ...items.map((item) => item.value));
  const safeCeiling = ceiling > 0 ? ceiling : 1;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {items.map((item) => {
        const width = Math.max(2, Math.min(100, (item.value / safeCeiling) * 100));
        const row = (
          <>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">{item.label}</span>
              <span className="flex shrink-0 items-baseline gap-1.5">
                {item.hint && <span className="text-xs text-muted-foreground">{item.hint}</span>}
                <span className="tabular-nums">{formatValue(item.value)}</span>
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full", colorClassName)} style={{ width: `${width}%` }} />
            </div>
          </>
        );

        if (item.href) {
          return (
            <Link key={item.key} href={item.href} className="rounded-md px-1.5 py-0.5 -mx-1.5 hover:bg-muted">
              {row}
            </Link>
          );
        }

        return (
          <div key={item.key} className="px-1.5 -mx-1.5">
            {row}
          </div>
        );
      })}
    </div>
  );
}

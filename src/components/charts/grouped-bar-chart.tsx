"use client";

import { formatCurrency, formatCurrencyWhole } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { ChartEmpty, ChartFrame, yAxisMargin, type FrameRender, type TooltipRow } from "./chart-frame";
import { CHART_GEOMETRY, labelCapacity, niceTicks, thinIndices } from "./theme";

const MARGIN_TOP = 12;
const MARGIN_RIGHT = 12;
const MARGIN_BOTTOM = 20;
/** Fraction of each slot's width kept as air between neighboring slots. */
const SLOT_PADDING = 0.24;
const MAX_BAR_WIDTH = 24;
const MUTED_OPACITY = 0.45;
const GHOST_OPACITY = 0.25;
/** How much wider a ghost bar sits than the real bar it stands behind, in px. */
const GHOST_OVERHANG = 6;

type Bar = { key: string; label: string; values: number[]; muted?: boolean; ghost?: number[] };

/**
 * Paired vertical bars sharing a single y-scale — never a second axis, even
 * when the two series live on different natural scales; that's the #1 dataviz
 * mistake this app avoids by construction. Good for "tell distinct series
 * apart" against a common baseline (e.g. this month vs. last month).
 *
 * A color legend row renders above the plot whenever more than one thing is
 * painted — two series, or a single series plus its ghost comparison (whose
 * entry carries `ghostName` at the ghost's opacity). Identity is never
 * tooltip-only. Its text uses plain ink, never the series color, so it stays
 * legible regardless of hue. Bars cap
 * at 24px so they never bloat into blocks, get a 4px rounded data end (square
 * at the shared zero baseline), a 2px gap inside a slot and a wider gap
 * between slots. `muted` bars (pure context) render at lower opacity so the
 * real data keeps priority; `ghost` values render as a faint, slightly wider
 * shadow *behind* the real bar, so a period-over-period comparison reads
 * without ever obscuring the current number.
 *
 * Hover/tap anywhere (or Arrow keys, once the frame has focus) highlights the
 * nearest slot and opens the frame's HTML tooltip with every series' exact
 * value for that slot.
 *
 * Height is CSS-driven: pass a height class (e.g. `className="h-45 sm:h-55"`)
 * and the plot takes whatever the legend leaves; the `height` prop is the
 * pre-measure fallback.
 */
export function GroupedBarChart(props: {
  bars: Bar[];
  series: { name: string; color: string }[];
  /** Accessible name; rendered as the SVG <title>, not visible text. */
  title: string;
  currency: string;
  height?: number;
  className?: string;
  /** Name shown in the tooltip for the ghost values, e.g. "Same month 2025". */
  ghostName?: string;
  /** Dashed horizontal reference line with a small right-aligned label. */
  reference?: { label: string; value: number } | null;
  /** Axis rounding. Tooltips are always exact. */
  valueFormat?: "exact" | "whole";
}) {
  const {
    bars,
    series,
    title,
    currency,
    height = 220,
    className,
    ghostName = "Previous",
    reference = null,
    valueFormat = "whole",
  } = props;

  const formatAxis = (value: number) =>
    valueFormat === "exact" ? formatCurrency(value, currency) : formatCurrencyWhole(value, currency);

  // Identity is never tooltip-only: as soon as more than one thing is painted
  // — two series, or one series plus its ghost — the legend names them.
  const hasGhost = bars.some((bar) => (bar.ghost ?? []).length > 0);
  const legendItems: { name: string; color: string; opacity: number }[] = [];
  if (series.length >= 2 || hasGhost) {
    for (const s of series) legendItems.push({ name: s.name, color: s.color, opacity: 1 });
    if (hasGhost) {
      legendItems.push({ name: ghostName, color: series[0]?.color ?? "var(--foreground)", opacity: GHOST_OPACITY });
    }
  }
  const legend =
    legendItems.length > 0 ? (
      <div className="mb-2 flex flex-wrap items-center gap-3">
        {legendItems.map((item) => (
          <div key={item.name} className="flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: item.color, opacity: item.opacity }}
            />
            <span className="text-xs font-medium text-muted-foreground">{item.name}</span>
          </div>
        ))}
      </div>
    ) : null;

  if (bars.length === 0) {
    return (
      <div className={cn("flex flex-col", className)}>
        {legend}
        <ChartEmpty height={height} />
      </div>
    );
  }

  const allValues = bars.flatMap((bar) => [...bar.values, ...(bar.ghost ?? [])]);
  if (reference) allValues.push(reference.value);
  const { niceMin, niceMax, ticks } = niceTicks(Math.min(0, ...allValues), Math.max(0, ...allValues), 4);
  const span = niceMax - niceMin || 1;

  const tickLabels = ticks.map(formatAxis);
  const marginLeft = yAxisMargin(tickLabels);
  const seriesCount = Math.max(1, series.length);

  const render = (width: number, frameHeight: number): FrameRender => {
    const plotWidth = Math.max(1, width - marginLeft - MARGIN_RIGHT);
    const plotHeight = Math.max(1, frameHeight - MARGIN_TOP - MARGIN_BOTTOM);
    const yAt = (value: number) => MARGIN_TOP + plotHeight - ((value - niceMin) / span) * plotHeight;
    const baselineY = yAt(0);

    const slotWidth = plotWidth / bars.length;
    const barsAreaWidth = slotWidth * (1 - SLOT_PADDING);
    const barGap = CHART_GEOMETRY.barGap;
    const barWidth = Math.max(
      1,
      Math.min(MAX_BAR_WIDTH, (barsAreaWidth - (seriesCount - 1) * barGap) / seriesCount),
    );
    const groupWidth = barWidth * seriesCount + barGap * (seriesCount - 1);
    const slotCenter = (index: number) => marginLeft + slotWidth * index + slotWidth / 2;
    const barX = (index: number, seriesIndex: number) =>
      slotCenter(index) - groupWidth / 2 + seriesIndex * (barWidth + barGap);

    const labelIndices = new Set(thinIndices(bars.length, labelCapacity(plotWidth)));

    const content = (
      <>
        {/* Gridlines + currency y-ticks, shared by every series — one axis, always. */}
        <g>
          {ticks.map((tick, i) => {
            const y = yAt(tick);
            return (
              <g key={tick}>
                <line
                  x1={marginLeft}
                  x2={width - MARGIN_RIGHT}
                  y1={y}
                  y2={y}
                  stroke={CHART_GEOMETRY.gridStroke}
                  strokeWidth={CHART_GEOMETRY.gridStrokeWidth}
                />
                <text
                  x={marginLeft - 8}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={CHART_GEOMETRY.tickFontSize}
                  fill={CHART_GEOMETRY.axisInk}
                >
                  {tickLabels[i]}
                </text>
              </g>
            );
          })}
        </g>

        {/* Ghost bars first: same hue, faint, a touch wider, so the real bar
            always sits in front of its own shadow. */}
        <g>
          {bars.map((bar, index) =>
            (bar.ghost ?? []).map((value, seriesIndex) => {
              const s = series[seriesIndex];
              if (!s) return null;
              const ghostWidth = Math.min(barWidth + GHOST_OVERHANG, slotWidth);
              const x = barX(index, seriesIndex) - (ghostWidth - barWidth) / 2;
              const y = yAt(value);
              const top = Math.min(y, baselineY);
              const barHeight = Math.max(0, Math.abs(y - baselineY));
              if (barHeight <= 0) return null;
              return (
                <path
                  key={`${bar.key}-ghost-${s.name}`}
                  d={roundedBarPath(x, top, ghostWidth, barHeight, CHART_GEOMETRY.barRadius, value >= 0)}
                  fill={s.color}
                  opacity={GHOST_OPACITY}
                />
              );
            }),
          )}
        </g>

        {/* Bars. */}
        <g>
          {bars.map((bar, index) => (
            <g key={bar.key} opacity={bar.muted ? MUTED_OPACITY : 1}>
              {bar.values.map((value, seriesIndex) => {
                const s = series[seriesIndex];
                if (!s) return null;
                const y = yAt(value);
                const top = Math.min(y, baselineY);
                const barHeight = Math.max(0, Math.abs(y - baselineY));
                if (barHeight <= 0) return null;
                return (
                  <path
                    key={s.name}
                    d={roundedBarPath(barX(index, seriesIndex), top, barWidth, barHeight, CHART_GEOMETRY.barRadius, value >= 0)}
                    fill={s.color}
                  />
                );
              })}
            </g>
          ))}
        </g>

        {/* Reference line (e.g. the average) — dashed, recessive, labelled once. */}
        {reference && (
          <g>
            <line
              x1={marginLeft}
              x2={width - MARGIN_RIGHT}
              y1={yAt(reference.value)}
              y2={yAt(reference.value)}
              stroke={CHART_GEOMETRY.axisInk}
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <text
              x={width - MARGIN_RIGHT}
              y={Math.max(9, yAt(reference.value) - 4)}
              textAnchor="end"
              fontSize={CHART_GEOMETRY.tickFontSize}
              fill={CHART_GEOMETRY.axisInk}
            >
              {reference.label}
            </text>
          </g>
        )}

        {/* X labels, thinned against the real plot width so they never collide. */}
        <g>
          {bars.map((bar, i) => {
            if (!labelIndices.has(i)) return null;
            return (
              <text
                key={bar.key}
                x={slotCenter(i)}
                y={frameHeight - 4}
                textAnchor={i === 0 ? "start" : i === bars.length - 1 ? "end" : "middle"}
                fontSize={CHART_GEOMETRY.tickFontSize}
                fill={CHART_GEOMETRY.axisInk}
              >
                {bar.label}
              </text>
            );
          })}
        </g>
      </>
    );

    return {
      content,
      slotCenters: bars.map((_, i) => slotCenter(i)),
      activeMark: (index) => (
        <rect
          pointerEvents="none"
          x={slotCenter(index) - slotWidth / 2}
          y={MARGIN_TOP}
          width={slotWidth}
          height={plotHeight}
          fill="var(--foreground)"
          opacity={0.05}
        />
      ),
      tooltipFor: (index) => {
        const bar = bars[index];
        const rows: TooltipRow[] = [];
        let topY = baselineY;
        bar.values.forEach((value, seriesIndex) => {
          const s = series[seriesIndex];
          if (!s) return;
          topY = Math.min(topY, yAt(value));
          rows.push({
            name: s.name,
            color: s.color,
            value: formatCurrency(value, currency),
          });
        });
        (bar.ghost ?? []).forEach((value, seriesIndex) => {
          const s = series[seriesIndex];
          if (!s) return;
          topY = Math.min(topY, yAt(value));
          rows.push({
            name: series.length > 1 ? `${ghostName} · ${s.name}` : ghostName,
            color: s.color,
            value: formatCurrency(value, currency),
          });
        });
        if (rows.length === 0) return null;
        return { x: slotCenter(index), y: topY, label: bar.label, rows };
      },
    };
  };

  return (
    <div className={cn("flex flex-col", className)}>
      {legend}
      <ChartFrame title={title} height={height} className="min-h-0 shrink grow basis-auto" render={render} />
    </div>
  );
}

/**
 * A bar path rounded only at its data end (the end away from the zero
 * baseline) and square where it meets the baseline — never a fully pill-shaped
 * bar, per the mark spec.
 */
function roundedBarPath(
  x: number,
  top: number,
  width: number,
  barHeight: number,
  radius: number,
  positive: boolean,
): string {
  const r = Math.max(0, Math.min(radius, width / 2, barHeight));
  if (r <= 0) {
    return `M${x},${top} h${width} v${barHeight} h${-width} Z`;
  }
  if (positive) {
    return [
      `M${x},${top + r}`,
      `a${r},${r} 0 0 1 ${r},${-r}`,
      `h${width - 2 * r}`,
      `a${r},${r} 0 0 1 ${r},${r}`,
      `v${barHeight - r}`,
      `h${-width}`,
      `Z`,
    ].join(" ");
  }
  return [
    `M${x},${top}`,
    `h${width}`,
    `v${barHeight - r}`,
    `a${r},${r} 0 0 1 ${-r},${r}`,
    `h${-(width - 2 * r)}`,
    `a${r},${r} 0 0 1 ${-r},${-r}`,
    `Z`,
  ].join(" ");
}

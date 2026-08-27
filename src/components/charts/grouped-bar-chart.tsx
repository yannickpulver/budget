import { CHART_GEOMETRY, labelCapacity, niceTicks, thinIndices } from "./theme";

const VIEW_WIDTH = 600;
const MARGIN = { top: 12, right: 8, bottom: 20, left: 52 };
/** Fraction of each slot's width kept as air between neighboring slots. */
const SLOT_PADDING = 0.24;
const MAX_BAR_WIDTH = 24;
const MUTED_OPACITY = 0.45;

/**
 * Paired vertical bars sharing a single y-scale — never a second axis, even
 * when the two series live on different natural scales; that's the #1
 * dataviz mistake this app avoids by construction. Good for "tell distinct
 * series apart" against a common baseline (e.g. this month vs. last month).
 *
 * Because there can be two series, a color legend row renders above the
 * plot (mandatory once you're comparing identities by hue) — its text uses
 * plain ink, never the series color, so it stays legible regardless of hue.
 * Bars cap at 24px so they never bloat into blocks, get a 4px rounded data
 * end at the top (square at the shared zero baseline), a 2px gap between the
 * paired bars in a slot, and a wider gap between slots. `muted` bars (pure
 * context, e.g. "average" reference bars) render at lower opacity so the
 * real data keeps visual priority. As with the line chart, there's no
 * client JS, so each bar's tooltip is a native SVG `<title>`.
 */
export function GroupedBarChart(props: {
  bars: {
    key: string;
    label: string;
    values: number[];
    muted?: boolean;
  }[];
  series: { name: string; color: string }[];
  title: string;
  formatValue: (value: number) => string;
  height?: number;
  className?: string;
}) {
  const { bars, series, title, formatValue, height = 200, className } = props;
  const plotWidth = VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const viewBox = `0 0 ${VIEW_WIDTH} ${height}`;

  if (bars.length === 0) {
    return (
      <svg viewBox={viewBox} width="100%" height={height} preserveAspectRatio="xMidYMid meet" className={className} role="img">
        <title>{title}</title>
        <text
          x={VIEW_WIDTH / 2}
          y={height / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={CHART_GEOMETRY.tickFontSize}
          fill={CHART_GEOMETRY.axisInk}
        >
          Not enough data yet
        </text>
      </svg>
    );
  }

  const allValues = bars.flatMap((b) => b.values);
  const { niceMin, niceMax, ticks } = niceTicks(Math.min(0, ...allValues), Math.max(0, ...allValues), 4);
  const span = niceMax - niceMin || 1;
  const yAt = (value: number) => MARGIN.top + plotHeight - ((value - niceMin) / span) * plotHeight;
  const baselineY = yAt(0);

  const slotWidth = plotWidth / bars.length;
  const barsAreaWidth = slotWidth * (1 - SLOT_PADDING);
  const seriesCount = Math.max(1, series.length);
  const barGap = CHART_GEOMETRY.barGap;
  const barWidth = Math.max(1, Math.min(MAX_BAR_WIDTH, (barsAreaWidth - (seriesCount - 1) * barGap) / seriesCount));
  const groupWidth = barWidth * seriesCount + barGap * (seriesCount - 1);

  const shownLabels = thinIndices(bars.length, labelCapacity(plotWidth));
  const labelIndices = new Set(shownLabels);
  const labelOrdinal = new Map(shownLabels.map((index, ordinal) => [index, ordinal]));

  return (
    <div className={className}>
      {series.length >= 2 && (
        <div className="mb-2 flex flex-wrap items-center gap-3">
          {series.map((s) => (
            <div key={s.name} className="flex items-center gap-1.5">
              <span className="inline-block size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
              <span className="text-xs font-medium text-muted-foreground">{s.name}</span>
            </div>
          ))}
        </div>
      )}

      <svg viewBox={viewBox} width="100%" height={height} preserveAspectRatio="xMidYMid meet" role="img">
        <title>{title}</title>

        {/* Gridlines + currency y-ticks, shared by both series — one axis, always. */}
        <g>
          {ticks.map((tick) => {
            const y = yAt(tick);
            return (
              <g key={tick}>
                <line
                  x1={MARGIN.left}
                  x2={VIEW_WIDTH - MARGIN.right}
                  y1={y}
                  y2={y}
                  stroke={CHART_GEOMETRY.gridStroke}
                  strokeWidth={CHART_GEOMETRY.gridStrokeWidth}
                />
                <text
                  x={MARGIN.left - 8}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={CHART_GEOMETRY.tickFontSize}
                  fill={CHART_GEOMETRY.axisInk}
                >
                  {formatValue(tick)}
                </text>
              </g>
            );
          })}
        </g>

        {/* Bars. */}
        <g>
          {bars.map((bar, slotIndex) => {
            const slotCenter = MARGIN.left + slotWidth * slotIndex + slotWidth / 2;
            const groupStart = slotCenter - groupWidth / 2;
            return (
              <g key={bar.key} opacity={bar.muted ? MUTED_OPACITY : 1}>
                {bar.values.map((value, seriesIndex) => {
                  const s = series[seriesIndex];
                  if (!s) return null;
                  const x = groupStart + seriesIndex * (barWidth + barGap);
                  const y = yAt(value);
                  const top = Math.min(y, baselineY);
                  const barHeight = Math.max(0, Math.abs(y - baselineY));
                  const r = Math.min(CHART_GEOMETRY.barRadius, barWidth / 2, barHeight);
                  return (
                    <g key={s.name}>
                      <title>{`${bar.label} · ${s.name}: ${formatValue(value)}`}</title>
                      {barHeight > 0 && (
                        <path
                          d={roundedBarPath(x, top, barWidth, barHeight, r, value >= 0)}
                          fill={s.color}
                        />
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </g>

        {/* X labels, thinned so they never overlap even at ~75 slots. Every
            second one also carries `chart-x-tick-alt`, which CSS drops below
            480px — the viewBox scales with the container, so a phone needs
            half as many labels as the thinning maths assumes. */}
        <g>
          {bars.map((bar, i) => {
            if (!labelIndices.has(i)) return null;
            const slotCenter = MARGIN.left + slotWidth * i + slotWidth / 2;
            const anchor = i === 0 ? "start" : i === bars.length - 1 ? "end" : "middle";
            const alt = labelOrdinal.get(i)! % 2 === 1 && i !== bars.length - 1;
            return (
              <text
                key={bar.key}
                x={slotCenter}
                y={height - 4}
                textAnchor={anchor}
                fontSize={CHART_GEOMETRY.tickFontSize}
                fill={CHART_GEOMETRY.axisInk}
                className={alt ? "chart-tick chart-x-tick-alt" : "chart-tick"}
              >
                {bar.label}
              </text>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

/**
 * A bar path rounded only at its data end (the end away from the zero
 * baseline) and square where it meets the baseline — never a fully pill-
 * shaped bar, per the mark spec.
 */
function roundedBarPath(x: number, top: number, width: number, barHeight: number, radius: number, positive: boolean): string {
  const r = Math.max(0, Math.min(radius, width / 2, barHeight));
  if (r <= 0) {
    return `M${x},${top} h${width} v${barHeight} h${-width} Z`;
  }
  if (positive) {
    // Rounded at the top, square at the bottom (baseline).
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
  // Negative value: bar grows downward from the baseline, so the rounded
  // (data) end is at the bottom instead.
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

import { CHART_COLORS, CHART_GEOMETRY, labelCapacity, niceTicks, thinIndices } from "./theme";

const VIEW_WIDTH = 600;
const MARGIN = { top: 12, right: 8, bottom: 20, left: 52 };

/** Lowercase, alphanumeric-and-hyphen only — safe as an SVG id fragment. */
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Single-series net-worth line, rendered as static inline SVG (no client JS —
 * this is a server component). A line is the right form here because the
 * job is "trend over time" for one series: sequential/neutral ink, not
 * categorical color, since there's nothing to tell apart.
 *
 * Encoding: a 2px neutral line over a very faint same-hue area wash, 3-4
 * recessive gridlines with currency y-ticks (a zero line falls out of the
 * tick rounding whenever the domain crosses zero), x labels thinned to at
 * most ~6 so they never collide, and a single 8px marker + direct label on
 * the final point (the endpoint is the story; every other point would just
 * be noise). Because there's only one series, no legend box is drawn — the
 * caller's heading already names what's plotted.
 *
 * There is no JS to drive a hover tooltip, so each point carries a native
 * SVG `<title>` inside its own `<g>` — hovering (or focusing, for
 * accessibility tooling that walks the DOM) surfaces the exact value even
 * though nothing here is scripted.
 */
export function LineChart(props: {
  points: { key: string; label: string; value: number }[];
  /** Accessible name; rendered as the SVG <title>, not visible text. The caller renders its own heading. */
  title: string;
  formatValue: (value: number) => string;
  height?: number;
  className?: string;
}) {
  const { points, title, formatValue, height = 180, className } = props;
  const plotWidth = VIEW_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const viewBox = `0 0 ${VIEW_WIDTH} ${height}`;

  if (points.length < 2) {
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

  const values = points.map((p) => p.value);
  const { niceMin, niceMax, ticks } = niceTicks(Math.min(...values), Math.max(...values), 4);
  const span = niceMax - niceMin || 1;

  const xAt = (index: number) => MARGIN.left + (index / (points.length - 1)) * plotWidth;
  const yAt = (value: number) => MARGIN.top + plotHeight - ((value - niceMin) / span) * plotHeight;

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(2)},${yAt(p.value).toFixed(2)}`).join(" ");
  const baselineY = MARGIN.top + plotHeight;
  const areaPath = `${linePath} L${xAt(points.length - 1).toFixed(2)},${baselineY.toFixed(2)} L${xAt(0).toFixed(2)},${baselineY.toFixed(2)} Z`;

  const labelIndices = new Set(thinIndices(points.length, labelCapacity(plotWidth)));
  const last = points[points.length - 1];
  const lastX = xAt(points.length - 1);
  const lastY = yAt(last.value);
  // Derived from `title` (not useId — this is a server component) so two
  // LineCharts on one page never collide over the same <linearGradient> id.
  const gradientId = `line-chart-area-fill-${slugify(title)}`;

  return (
    <svg viewBox={viewBox} width="100%" height={height} preserveAspectRatio="xMidYMid meet" className={className} role="img">
      <title>{title}</title>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={CHART_COLORS.neutral} stopOpacity={CHART_GEOMETRY.areaFillOpacity} />
          <stop offset="100%" stopColor={CHART_COLORS.neutral} stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Gridlines + currency y-ticks. The tick nearest 0, if in range, doubles as the zero line. */}
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

      {/* Area wash beneath the line — a hint of magnitude, never a saturated block. */}
      <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />

      {/* The line itself. */}
      <path
        d={linePath}
        fill="none"
        stroke={CHART_COLORS.neutral}
        strokeWidth={CHART_GEOMETRY.lineStrokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Per-point hover targets: invisible, larger than the visible marks, each with a native tooltip. */}
      {points.map((p, i) => (
        <g key={p.key}>
          <title>{`${p.label}: ${formatValue(p.value)}`}</title>
          <circle cx={xAt(i)} cy={yAt(p.value)} r={10} fill="transparent" />
        </g>
      ))}

      {/* End marker + direct label — the endpoint is the one value worth calling out. */}
      <g>
        <circle
          cx={lastX}
          cy={lastY}
          r={CHART_GEOMETRY.markerDiameter / 2}
          fill={CHART_COLORS.neutral}
          stroke="var(--background)"
          strokeWidth={2}
        />
        <text
          x={Math.min(lastX, VIEW_WIDTH - MARGIN.right - 4)}
          y={lastY - 10}
          textAnchor="end"
          fontSize={CHART_GEOMETRY.tickFontSize + 1}
          fontWeight={600}
          fill="var(--foreground)"
        >
          {formatValue(last.value)}
        </text>
      </g>

      {/* X labels, thinned so they never overlap; first and last are always kept. */}
      <g>
        {points.map((p, i) => {
          if (!labelIndices.has(i)) return null;
          const x = xAt(i);
          const anchor = i === 0 ? "start" : i === points.length - 1 ? "end" : "middle";
          return (
            <text
              key={p.key}
              x={x}
              y={height - 4}
              textAnchor={anchor}
              fontSize={CHART_GEOMETRY.tickFontSize}
              fill={CHART_GEOMETRY.axisInk}
            >
              {p.label}
            </text>
          );
        })}
      </g>
    </svg>
  );
}

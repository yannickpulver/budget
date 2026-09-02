import { cn } from "@/lib/utils";
import { CHART_COLORS, CHART_GEOMETRY } from "./theme";

/** Vertical breathing room, in px, so the extremes never touch the edge. */
const PAD = 2;

/**
 * An axis-less, label-less micro line — the trend shape only, meant to sit
 * inside a stat tile or a table row where a real chart would be too loud.
 * It is decorative by construction: `aria-hidden`, no tooltip, no numbers.
 * The value it illustrates must always be stated in text beside it.
 *
 * Being 32px tall and axis-free, it is the one chart here that may stretch:
 * it scales horizontally via a `preserveAspectRatio="none"` viewBox, with a
 * non-scaling stroke so the 1.5px line stays 1.5px at any width. The end dot
 * is an HTML element rather than an SVG circle for the same reason — a circle
 * inside a non-uniformly scaled viewBox would render as an ellipse.
 *
 * Fewer than 2 points renders nothing — this is the single guard; callers do
 * not need to repeat it.
 */
export function Sparkline(props: {
  /** At least 2 values; anything shorter renders nothing. */
  points: number[];
  height?: number;
  className?: string;
  /** Stroke color; defaults to the neutral single-series ink. */
  color?: string;
}) {
  const { points, height = 32, className, color = CHART_COLORS.neutral } = props;
  if (points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const usable = Math.max(1, height - PAD * 2);

  const xAt = (index: number) => (index / (points.length - 1)) * 100;
  const yAt = (value: number) => PAD + (1 - (value - min) / span) * usable;

  const linePath = points
    .map((value, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(3)},${yAt(value).toFixed(2)}`)
    .join(" ");
  // A signed series (e.g. net) must not read as all-positive: when the data
  // crosses zero the wash fills between the line and the zero line, so the
  // deficit months sit visibly below it. A one-signed series keeps the plain
  // fill down to the box.
  const crossesZero = min < 0 && max > 0;
  const zeroY = yAt(0);
  const areaPath = crossesZero
    ? `${linePath} L100,${zeroY.toFixed(2)} L0,${zeroY.toFixed(2)} Z`
    : `${linePath} L100,${height} L0,${height} Z`;
  const endTop = yAt(points[points.length - 1]);

  return (
    <span aria-hidden className={cn("relative block w-full", className)} style={{ height }}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="block"
      >
        <path d={areaPath} fill={color} fillOpacity={CHART_GEOMETRY.areaFillOpacity} stroke="none" />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span
        className="absolute block rounded-full"
        style={{
          left: "100%",
          top: endTop,
          width: 3,
          height: 3,
          backgroundColor: color,
          transform: "translate(-100%, -50%)",
        }}
      />
    </span>
  );
}

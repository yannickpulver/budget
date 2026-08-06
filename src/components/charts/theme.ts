/**
 * Shared color and geometry tokens for the chart primitives in this folder.
 *
 * Kept tiny and centralized so every chart draws from the same ramp: the
 * categorical pair below has already been run through the dataviz-skill
 * palette validator against this app's light surface (all six checks pass —
 * lightness band, chroma floor, adjacent-pair CVD separation, the
 * normal-vision floor, and contrast), so don't substitute other hues here.
 */

/** The only colors a chart may paint a mark with. Text never wears these. */
export const CHART_COLORS = {
  /** Income / positive movement — emerald-600, matches the rest of the app. */
  income: "#059669",
  /** Spending / negative movement — red-600, matches the rest of the app. */
  spending: "#dc2626",
  /** Single-series default (net worth, one bar series) — near-black ink. */
  neutral: "var(--foreground)",
} as const;

/** Geometry and ink shared by every chart so they read as one system. */
export const CHART_GEOMETRY = {
  /** Gridline stroke — recessive, one step off the surface. */
  gridStroke: "var(--border)",
  gridStrokeWidth: 1,
  /** Axis tick text color. */
  axisInk: "var(--muted-foreground)",
  /** Axis tick font size, in px. */
  tickFontSize: 10.5,
  /** Line mark stroke width, in px. */
  lineStrokeWidth: 2,
  /** Minimum marker/end-dot diameter, in px. */
  markerDiameter: 8,
  /** Surface-color gap separating adjacent bars, in px. */
  barGap: 2,
  /** Corner radius applied to the outward (data) end of a bar/column, in px. */
  barRadius: 4,
  /** Area-fill opacity beneath a line (a wash, never a saturated block). */
  areaFillOpacity: 0.08,
  /**
   * Horizontal room an x-axis label needs before its neighbour, in px. Wide
   * enough for the longest label these charts emit ("Jan '26"). Label density
   * is derived from the plot width over this, so a 7-bar yearly chart labels
   * every bar while a 74-point monthly one thins down.
   */
  minLabelSpacing: 52,
} as const;

/** How many x-axis labels fit across `plotWidth` without crowding. */
export function labelCapacity(plotWidth: number): number {
  return Math.max(2, Math.floor(plotWidth / CHART_GEOMETRY.minLabelSpacing));
}

/** A "nice" round number close to `value` — 1/2/5/10 × a power of ten. */
function niceNumber(value: number, round: boolean): number {
  const safeValue = value <= 0 ? 1 : value;
  const exponent = Math.floor(Math.log10(safeValue));
  const fraction = safeValue / 10 ** exponent;
  let niceFraction: number;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else {
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
  }
  return niceFraction * 10 ** exponent;
}

/**
 * Round a `[min, max]` data domain out to clean tick values (3-4 gridlines),
 * so y-axis labels read as 0 / 1,000 / 2,000 rather than jagged data bounds.
 * If the resulting domain spans zero, 0 is guaranteed to be one of the ticks
 * — that tick doubles as the "zero line" a diverging series needs.
 */
export function niceTicks(min: number, max: number, targetCount = 4): { niceMin: number; niceMax: number; ticks: number[] } {
  let lo = min;
  let hi = max;
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const range = niceNumber(hi - lo, false);
  const step = niceNumber(range / Math.max(1, targetCount - 1), true);
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { niceMin, niceMax, ticks };
}

/**
 * Pick a subset of indices (always including the first and last) so at most
 * `target` x-axis labels are drawn regardless of how many data points there
 * are — labels stay legible even at ~75 slots (all-time monthly data).
 */
export function thinIndices(count: number, target = 6): number[] {
  if (count <= 0) return [];
  if (count <= target) return Array.from({ length: count }, (_, i) => i);
  const step = Math.ceil((count - 1) / (target - 1));
  const indices: number[] = [];
  for (let i = 0; i < count; i += step) indices.push(i);
  const last = count - 1;
  if (indices[indices.length - 1] !== last) {
    // The last slot is always labelled. Dropping the stepped index before it
    // when it sits closer than a full step keeps the pair from crowding —
    // otherwise a 12-month axis ends on "Nov Dec" jammed together.
    if (last - indices[indices.length - 1] < step) indices.pop();
    indices.push(last);
  }
  return indices;
}

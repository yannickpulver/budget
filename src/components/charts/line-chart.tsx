"use client";

import { useId } from "react";
import { formatCurrency, formatCurrencyWhole } from "@/lib/currency";
import { ChartEmpty, ChartFrame, yAxisMargin, type FrameRender } from "./chart-frame";
import { CHART_COLORS, CHART_GEOMETRY, labelCapacity, niceTicks, thinIndices } from "./theme";

const MARGIN_TOP = 12;
const MARGIN_RIGHT = 12;
const MARGIN_BOTTOM = 20;

type Point = { key: string; label: string; value: number };

/**
 * Single-series line over time, drawn at real pixel size inside `ChartFrame`.
 * A line is the right form here because the job is "trend over time" for one
 * series: sequential/neutral ink, not categorical color, since there is
 * nothing to tell apart.
 *
 * Encoding: a 2px neutral line over a very faint same-hue area wash, 3-4
 * recessive gridlines with currency y-ticks (a zero line falls out of the
 * tick rounding whenever the domain crosses zero), x labels thinned against
 * the *measured* plot width so they never collide at any viewport, and a
 * single 8px marker + direct label on the final point — the endpoint is the
 * story; a number on every point would just be noise. An optional `ghost`
 * series (e.g. the previous year) is drawn faint and dashed behind the real
 * line; it never competes for attention and needs no legend.
 *
 * Hovering or tapping anywhere — or the Arrow keys once the frame has focus —
 * snaps a crosshair to the nearest point and opens the frame's HTML tooltip
 * with the exact (unrounded) values. Height is CSS-driven: pass a height class
 * (e.g. `className="h-45 sm:h-55"`); the `height` prop is the pre-measure
 * fallback and the reserved height when no class sets one.
 */
export function LineChart(props: {
  points: Point[];
  /** Accessible name; rendered as the SVG <title>, not visible text. */
  title: string;
  currency: string;
  height?: number;
  className?: string;
  /** Optional second series drawn faint/dashed behind, same x count. */
  ghost?: { label: string; points: Point[] } | null;
  /** Direct end-label on the last point. */
  endLabel?: boolean;
  /** Axis/end-label rounding. Tooltips are always exact. */
  valueFormat?: "exact" | "whole";
}) {
  const { points, title, currency, height = 200, className, ghost = null, endLabel = true, valueFormat = "whole" } = props;
  const formatAxis = (value: number) =>
    valueFormat === "exact" ? formatCurrency(value, currency) : formatCurrencyWhole(value, currency);
  const gradientId = `line-area-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  if (points.length < 2) return <ChartEmpty height={height} className={className} />;

  const ghostPoints = ghost && ghost.points.length === points.length ? ghost.points : null;
  const values = points.map((p) => p.value);
  if (ghostPoints) values.push(...ghostPoints.map((p) => p.value));
  const { niceMin, niceMax, ticks } = niceTicks(Math.min(...values), Math.max(...values), 4);
  const span = niceMax - niceMin || 1;

  const tickLabels = ticks.map(formatAxis);
  const marginLeft = yAxisMargin(tickLabels);

  const render = (width: number, frameHeight: number): FrameRender => {
    const plotWidth = Math.max(1, width - marginLeft - MARGIN_RIGHT);
    const plotHeight = Math.max(1, frameHeight - MARGIN_TOP - MARGIN_BOTTOM);
    const baselineY = MARGIN_TOP + plotHeight;

    const xAt = (index: number) => marginLeft + (index / (points.length - 1)) * plotWidth;
    const yAt = (value: number) => MARGIN_TOP + plotHeight - ((value - niceMin) / span) * plotHeight;

    const pathFor = (series: Point[]) =>
      series.map((p, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(2)},${yAt(p.value).toFixed(2)}`).join(" ");

    const linePath = pathFor(points);
    const areaPath = `${linePath} L${xAt(points.length - 1).toFixed(2)},${baselineY.toFixed(2)} L${xAt(0).toFixed(2)},${baselineY.toFixed(2)} Z`;

    const labelIndices = new Set(thinIndices(points.length, labelCapacity(plotWidth)));
    const lastIndex = points.length - 1;
    const last = points[lastIndex];

    const content = (
      <>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART_COLORS.neutral} stopOpacity={CHART_GEOMETRY.areaFillOpacity} />
            <stop offset="100%" stopColor={CHART_COLORS.neutral} stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Gridlines + currency y-ticks. The tick nearest 0, if in range, doubles as the zero line. */}
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

        {/* Area wash beneath the line — a hint of magnitude, never a saturated block. */}
        <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />

        {/* Comparison series, deliberately recessive: faint, dashed, behind. */}
        {ghostPoints && (
          <path
            d={pathFor(ghostPoints)}
            fill="none"
            stroke={CHART_COLORS.neutral}
            strokeOpacity={0.3}
            strokeWidth={CHART_GEOMETRY.lineStrokeWidth - 0.5}
            strokeDasharray="4 3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        <path
          d={linePath}
          fill="none"
          stroke={CHART_COLORS.neutral}
          strokeWidth={CHART_GEOMETRY.lineStrokeWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* End marker + direct label — the endpoint is the one value worth calling out. */}
        <g>
          <circle
            cx={xAt(lastIndex)}
            cy={yAt(last.value)}
            r={CHART_GEOMETRY.markerDiameter / 2}
            fill={CHART_COLORS.neutral}
            stroke="var(--background)"
            strokeWidth={2}
          />
          {endLabel && (
            <text
              x={Math.min(xAt(lastIndex), width - MARGIN_RIGHT)}
              y={Math.max(11, yAt(last.value) - 10)}
              textAnchor="end"
              fontSize={CHART_GEOMETRY.tickFontSize + 1}
              fontWeight={600}
              fill="var(--foreground)"
            >
              {formatAxis(last.value)}
            </text>
          )}
        </g>

        {/* X labels, thinned against the real plot width so they never collide. */}
        <g>
          {points.map((p, i) => {
            if (!labelIndices.has(i)) return null;
            return (
              <text
                key={p.key}
                x={xAt(i)}
                y={frameHeight - 4}
                textAnchor={i === 0 ? "start" : i === lastIndex ? "end" : "middle"}
                fontSize={CHART_GEOMETRY.tickFontSize}
                fill={CHART_GEOMETRY.axisInk}
              >
                {p.label}
              </text>
            );
          })}
        </g>
      </>
    );

    return {
      content,
      slotCenters: points.map((_, i) => xAt(i)),
      activeMark: (index) => (
        <g pointerEvents="none">
          <line
            x1={xAt(index)}
            x2={xAt(index)}
            y1={MARGIN_TOP}
            y2={baselineY}
            stroke={CHART_GEOMETRY.axisInk}
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <circle
            cx={xAt(index)}
            cy={yAt(points[index].value)}
            r={CHART_GEOMETRY.markerDiameter / 2}
            fill={CHART_COLORS.neutral}
            stroke="var(--background)"
            strokeWidth={2}
          />
        </g>
      ),
      tooltipFor: (index) => {
        const point = points[index];
        const ghostPoint = ghostPoints?.[index];
        return {
          x: xAt(index),
          y: yAt(point.value),
          label: point.label,
          rows: [
            {
              // The frame hides names when there's only this one row.
              name: title,
              color: CHART_COLORS.neutral,
              value: formatCurrency(point.value, currency),
            },
            ...(ghostPoint && ghost
              ? [
                  {
                    name: ghost.label,
                    color: "var(--muted-foreground)",
                    value: formatCurrency(ghostPoint.value, currency),
                  },
                ]
              : []),
          ],
        };
      },
    };
  };

  return <ChartFrame title={title} height={height} className={className} render={render} />;
}

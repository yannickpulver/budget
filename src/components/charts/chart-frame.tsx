"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CHART_GEOMETRY } from "./theme";

/** Width assumed before the container has been measured (first paint / SSR). */
const DEFAULT_WIDTH = 600;

/** One line of the tooltip body. `name` is shown only when there are ≥2 rows. */
export type TooltipRow = { name?: string; color: string; value: string };

/** What a chart wants shown when slot `index` is active. */
export type TooltipSpec = {
  /** Anchor in frame pixel coordinates — the tooltip is placed near this. */
  x: number;
  y: number;
  label: string;
  rows: TooltipRow[];
};

export type FrameRender = {
  /** The SVG body, drawn in frame pixel coordinates. */
  content: ReactNode;
  /** x centre of every hoverable slot, in frame pixels. Drives hit-testing. */
  slotCenters: number[];
  /** Extra SVG drawn on top for the active slot (crosshair, highlight band). */
  activeMark?: (index: number) => ReactNode;
  /** Tooltip contents for a slot, or null to suppress it. */
  tooltipFor: (index: number) => TooltipSpec | null;
};

// useLayoutEffect warns during SSR; the charts are client components but Next
// still renders them on the server for the initial HTML.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The shared shell every axis-bearing chart in this folder draws into.
 *
 * It measures its own container with a `ResizeObserver` and hands the render
 * callback real pixel dimensions, so an SVG unit is a CSS pixel: a 10.5px
 * tick label is 10.5px on a 390px phone and on a 1200px desktop alike. (The
 * old fixed `viewBox="0 0 600 h"` scaled by CSS is what made phone labels
 * shrink to ~7px and forced a media-query hack.)
 *
 * Sizing contract — both dimensions are CSS-driven:
 * - Width always comes from the container.
 * - Height comes from the container too *when the caller gives it one in CSS*
 *   (e.g. `className="h-45 sm:h-55"`). The `height` prop is then only the
 *   pre-measure fallback used for the first (server) paint.
 * - With no CSS height, the wrapper is sized by the SVG itself, so `height`
 *   is the reserved height and nothing reflows.
 * Because the height is a class, a page can respond to a breakpoint without
 * mounting the same chart twice behind `hidden sm:block`.
 *
 * It also owns the single interactive layer: pointer moves are mapped to the
 * nearest slot centre and an absolutely positioned HTML tooltip is placed
 * beside that slot, flipping to stay inside the frame. The frame is focusable
 * and Arrow/Home/End step the active slot (Escape clears), so the values are
 * reachable without a pointer. The tooltip is inert (`pointer-events-none`,
 * `aria-hidden`) so it never steals focus or breaks the pointer stream; the
 * accessible reading of the chart is the `<title>`.
 */
export function ChartFrame(props: {
  /** Accessible name; rendered as the SVG <title>, not visible text. */
  title: string;
  /** Pre-measure fallback height, and the reserved height with no CSS height. */
  height: number;
  className?: string;
  render: (width: number, height: number) => FrameRender;
}) {
  const { title, height, className, render } = props;
  const frameRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [tipSize, setTipSize] = useState({ w: 0, h: 0 });

  // Measured before paint, so the CSS-driven height is in effect on the first
  // client frame and the box never visibly resizes.
  useIsoLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const apply = (nextWidth: number, nextHeight: number) => {
      const w = Math.round(nextWidth);
      const h = Math.round(nextHeight);
      if (w > 0) setWidth((prev) => (prev === w ? prev : w));
      if (h > 0) setMeasuredHeight((prev) => (prev === h ? prev : h));
    };
    const box = el.getBoundingClientRect();
    apply(box.width, box.height);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) apply(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Measured every render (cheap, and guarded against re-render loops) so the
  // flip/clamp maths below uses the tooltip's real box, not an estimate.
  useIsoLayoutEffect(() => {
    const el = tipRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setTipSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
  });

  // Escape dismisses; a pointerdown anywhere outside closes the tap-held
  // tooltip on touch, where there is no pointerleave to rely on.
  useEffect(() => {
    if (active === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActive(null);
    };
    const onDown = (event: PointerEvent) => {
      const el = frameRef.current;
      if (el && event.target instanceof Node && !el.contains(event.target)) setActive(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [active]);

  const frameHeight = measuredHeight ?? height;
  const frame = render(width, frameHeight);
  const { slotCenters } = frame;
  const slotCount = slotCenters.length;

  // Navigating to another period swaps the data under us: an index held from
  // the old series would index past the new one. Reset during render (the
  // sanctioned "derived from props" adjustment) and clamp defensively, so a
  // stale index can never reach `bars[i].values`.
  const [seenSlotCount, setSeenSlotCount] = useState(slotCount);
  if (seenSlotCount !== slotCount) {
    setSeenSlotCount(slotCount);
    setActive(null);
  }
  const activeIndex = active !== null && active < slotCount ? active : null;

  const pick = (clientX: number) => {
    const el = frameRef.current;
    if (!el || slotCount === 0) return;
    const x = clientX - el.getBoundingClientRect().left;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < slotCount; i++) {
      const distance = Math.abs(slotCenters[i] - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    setActive((prev) => (prev === best ? prev : best));
  };

  const stepActive = (delta: number) => {
    if (slotCount === 0) return;
    setActive((prev) => {
      if (prev === null || prev >= slotCount) return delta > 0 ? 0 : slotCount - 1;
      return Math.min(slotCount - 1, Math.max(0, prev + delta));
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (slotCount === 0) return;
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        stepActive(-1);
        break;
      case "ArrowRight":
        event.preventDefault();
        stepActive(1);
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(slotCount - 1);
        break;
      case "Escape":
        setActive(null);
        break;
      default:
        break;
    }
  };

  const tip = activeIndex === null ? null : frame.tooltipFor(activeIndex);

  let tipStyle: React.CSSProperties | undefined;
  if (tip) {
    const half = tipSize.w / 2;
    const minLeft = half + 4;
    const maxLeft = Math.max(minLeft, width - half - 4);
    const left = Math.min(Math.max(tip.x, minLeft), maxLeft);
    const above = tip.y - tipSize.h - 12 >= 0;
    const top = above
      ? tip.y - tipSize.h - 12
      : Math.min(tip.y + 12, Math.max(0, frameHeight - tipSize.h - 4));
    tipStyle = { left, top, transform: "translateX(-50%)" };
  }

  // One row is self-evident from the chart it hangs off; two or more have to
  // say which is which — including a real series paired with its ghost.
  const showRowNames = (tip?.rows.length ?? 0) > 1;

  return (
    <div
      ref={frameRef}
      tabIndex={0}
      role="group"
      aria-label={title}
      className={cn(
        "relative w-full rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/50",
        className,
      )}
      style={{ touchAction: "pan-y" }}
      onPointerMove={(event) => pick(event.clientX)}
      onPointerDown={(event) => pick(event.clientX)}
      onPointerLeave={() => setActive(null)}
      onPointerCancel={() => setActive(null)}
      onKeyDown={onKeyDown}
      onBlur={() => setActive(null)}
    >
      <svg
        width={width}
        height={frameHeight}
        viewBox={`0 0 ${width} ${frameHeight}`}
        role="img"
        className="block select-none"
      >
        <title>{title}</title>
        {frame.content}
        {activeIndex !== null && frame.activeMark?.(activeIndex)}
      </svg>

      {tip && (
        <div
          ref={tipRef}
          aria-hidden
          className="pointer-events-none absolute z-10 max-w-[calc(100%-8px)] rounded-md border border-border bg-popover px-2 py-1.5 text-xs tabular-nums text-popover-foreground shadow-sm"
          style={tipStyle}
        >
          <div className="font-medium">{tip.label}</div>
          <div className="mt-0.5 flex flex-col gap-0.5">
            {tip.rows.map((row, i) => (
              <div key={`${row.name ?? "value"}-${i}`} className="flex items-center gap-1.5">
                <span
                  className="inline-block size-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: row.color }}
                />
                {showRowNames && row.name && (
                  <span className="min-w-0 truncate text-muted-foreground">{row.name}</span>
                )}
                <span className="ml-auto whitespace-nowrap pl-2 font-medium">{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The shared "no data" placeholder, sized like the chart it stands in for. */
export function ChartEmpty(props: { height: number; className?: string }) {
  return (
    <div
      className={cn("flex w-full items-center justify-center", props.className)}
      style={{ height: props.height, fontSize: CHART_GEOMETRY.tickFontSize }}
    >
      <span className="text-muted-foreground">Not enough data yet</span>
    </div>
  );
}

/**
 * Left margin wide enough for the widest y-axis tick label. Measuring by
 * character count (~7px per glyph at the tick size, plus the 8px gap to the
 * plot) avoids a canvas text measurement while still letting a long
 * "CHF 250'000" fit whole and keeping small domains from wasting a fat gutter.
 */
export function yAxisMargin(tickLabels: string[]): number {
  const widest = tickLabels.reduce((max, label) => Math.max(max, label.length), 0);
  return Math.min(96, Math.max(40, Math.round(widest * 7) + 14));
}

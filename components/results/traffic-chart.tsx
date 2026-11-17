"use client";

import { useEffect, useRef, useState } from "react";
import type { DailyTrafficPoint } from "@/lib/lifecycle/results";
import { formatDay } from "@/components/visibility/primitives";

/**
 * Clicks and impressions per day, as two panels sharing one x axis.
 *
 * Two panels rather than one chart with two y scales, on purpose: impressions
 * run one or two orders of magnitude above clicks, and a dual-axis chart makes
 * the reader work out which scale a line belongs to before they can read it.
 * Small multiples answer the same question with none of that ambiguity.
 *
 * The hover layer is shared: one crosshair across both panels and one tooltip
 * with both values, because the reader's question is "what happened on that
 * day", not "what is this line". Every value the tooltip shows is also in the
 * table view below the chart, so nothing is gated behind a pointer.
 */

interface Series {
  key: "clicks" | "impressions";
  label: string;
  /** Categorical slot from globals.css, validated for both themes. */
  color: string;
}

const SERIES: Series[] = [
  { key: "clicks", label: "Clicks", color: "hsl(var(--chart-1))" },
  { key: "impressions", label: "Impressions", color: "hsl(var(--chart-2))" },
];

const PANEL_HEIGHT = 120;
const AXIS_HEIGHT = 22;
const PAD_LEFT = 44;
const PAD_RIGHT = 64;
const PAD_TOP = 10;

const GRID = "hsl(var(--border))";
const INK_MUTED = "hsl(var(--muted-foreground))";
const INK = "hsl(var(--foreground))";
const SURFACE = "hsl(var(--background))";

/** Rounds up to 1/2/5 x 10^n, so the top gridline is a clean number. */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (step * magnitude >= value) return step * magnitude;
  }
  return 10 * magnitude;
}

function compact(value: number): string {
  if (value < 1000) return String(value);
  const k = value / 1000;
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/**
 * "12 Aug" / "Aug 12" in the reader's locale, through the shared formatter.
 * A "YYYY-MM-DD" is read as that local day, so no timezone shifts it.
 */
function shortDay(day: string): string {
  return formatDay(day, { year: "never" });
}

/** Room one axis label needs, centre to centre, at the axis font size. */
export const MIN_TICK_SPACING = 64;

/**
 * Which days carry an x-axis label at this plot width. Ticks are spaced by
 * pixels, not by a fixed count: five labels fit a desktop panel and collide
 * on a phone. The first and the last day are always labelled, and a tick
 * too close to the last one is dropped rather than drawn on top of it.
 */
export function axisTickIndexes(
  count: number,
  innerWidth: number,
  minSpacing = MIN_TICK_SPACING
): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const last = count - 1;
  const perDay = Math.max(1, innerWidth) / last;
  const step = Math.max(1, Math.ceil(minSpacing / perDay));
  const ticks: number[] = [];
  for (let i = 0; i < last; i += step) ticks.push(i);
  while (ticks.length > 1 && (last - ticks[ticks.length - 1]) * perDay < minSpacing) ticks.pop();
  // Two days closer than one label: the last day alone carries the label.
  if (ticks.length === 1 && last * perDay < minSpacing) return [last];
  ticks.push(last);
  return ticks;
}

function Panel({
  days,
  series,
  width,
  hoverIndex,
  withAxis,
}: {
  days: DailyTrafficPoint[];
  series: Series;
  width: number;
  hoverIndex: number | null;
  withAxis: boolean;
}) {
  const height = PANEL_HEIGHT + (withAxis ? AXIS_HEIGHT : 0);
  const innerWidth = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
  const innerHeight = PANEL_HEIGHT - PAD_TOP - 6;
  const baseline = PAD_TOP + innerHeight;

  const max = niceCeil(Math.max(...days.map((d) => d[series.key])));
  const xAt = (index: number) =>
    days.length === 1
      ? PAD_LEFT + innerWidth / 2
      : PAD_LEFT + (index * innerWidth) / (days.length - 1);
  const yAt = (value: number) => PAD_TOP + innerHeight * (1 - value / max);

  const points = days.map((d, i) => ({ x: xAt(i), y: yAt(d[series.key]) }));
  const linePoints = points.map((p) => `${p.x},${p.y}`).join(" ");
  const areaPath =
    `M ${points[0].x} ${baseline} ` +
    points.map((p) => `L ${p.x} ${p.y}`).join(" ") +
    ` L ${points[points.length - 1].x} ${baseline} Z`;

  const last = points[points.length - 1];
  const lastValue = days[days.length - 1][series.key];

  // As many date ticks as the width holds without two labels touching.
  const tickIndexes = axisTickIndexes(days.length, innerWidth);

  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <span
          aria-hidden
          className="inline-block h-0.5 w-3 rounded-full"
          style={{ background: series.color }}
        />
        {series.label}
      </div>
      <svg width={width} height={height} aria-hidden className="block">
        {/* Recessive grid: baseline, midline, top, hairline solid. */}
        {[0, max / 2, max].map((tick) => (
          <g key={tick}>
            <line
              x1={PAD_LEFT}
              x2={width - PAD_RIGHT}
              y1={yAt(tick)}
              y2={yAt(tick)}
              stroke={GRID}
              strokeWidth={1}
            />
            <text
              x={PAD_LEFT - 6}
              y={yAt(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={10}
              style={{ fill: INK_MUTED, fontVariantNumeric: "tabular-nums" }}
            >
              {compact(tick)}
            </text>
          </g>
        ))}

        <path d={areaPath} style={{ fill: series.color, opacity: 0.1 }} />
        {days.length > 1 && (
          <polyline
            points={linePoints}
            fill="none"
            style={{ stroke: series.color }}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Crosshair: finds the X for the reader, snapped to a day. */}
        {hoverIndex !== null && (
          <g>
            <line
              x1={xAt(hoverIndex)}
              x2={xAt(hoverIndex)}
              y1={PAD_TOP}
              y2={baseline}
              stroke={INK_MUTED}
              strokeWidth={1}
            />
            <circle
              cx={xAt(hoverIndex)}
              cy={yAt(days[hoverIndex][series.key])}
              r={4.5}
              style={{ fill: series.color, stroke: SURFACE }}
              strokeWidth={2}
            />
          </g>
        )}

        {/* The end of the line carries its value; the ring keeps the marker
            legible where it sits on the line. */}
        <circle cx={last.x} cy={last.y} r={4} style={{ fill: series.color, stroke: SURFACE }} strokeWidth={2} />
        <text
          x={last.x + 8}
          y={last.y}
          dominantBaseline="middle"
          fontSize={11}
          fontWeight={500}
          style={{ fill: INK }}
        >
          {compact(lastValue)}
        </text>

        {withAxis &&
          tickIndexes.map((i) => (
            <text
              key={i}
              x={xAt(i)}
              y={baseline + 14}
              textAnchor="middle"
              fontSize={10}
              style={{ fill: INK_MUTED }}
            >
              {shortDay(days[i].day)}
            </text>
          ))}
      </svg>
    </div>
  );
}

export function TrafficChart({ days }: { days: DailyTrafficPoint[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(280, w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (days.length === 0) return null;

  const innerWidth = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
  const indexAt = (clientX: number, rect: DOMRect) => {
    const x = clientX - rect.left - PAD_LEFT;
    const step = days.length === 1 ? innerWidth : innerWidth / (days.length - 1);
    return Math.min(days.length - 1, Math.max(0, Math.round(x / step)));
  };

  const hovered = hoverIndex === null ? null : days[hoverIndex];
  const tooltipLeft =
    hoverIndex === null
      ? 0
      : Math.min(
          Math.max(8, PAD_LEFT + (days.length === 1 ? innerWidth / 2 : (hoverIndex * innerWidth) / (days.length - 1)) + 10),
          width - 168
        );

  return (
    <div
      ref={wrapRef}
      role="group"
      aria-label="Daily search traffic. Use the left and right arrow keys to read one day at a time; the same numbers are in the table below."
      tabIndex={0}
      className="relative space-y-2 rounded-lg border border-foreground/10 bg-muted/20 p-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onPointerMove={(e) => setHoverIndex(indexAt(e.clientX, e.currentTarget.getBoundingClientRect()))}
      onPointerLeave={() => setHoverIndex(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          setHoverIndex((i) => Math.min(days.length - 1, (i ?? -1) + 1));
          e.preventDefault();
        } else if (e.key === "ArrowLeft") {
          setHoverIndex((i) => Math.max(0, (i ?? days.length) - 1));
          e.preventDefault();
        } else if (e.key === "Home") {
          setHoverIndex(0);
          e.preventDefault();
        } else if (e.key === "End") {
          setHoverIndex(days.length - 1);
          e.preventDefault();
        } else if (e.key === "Escape") {
          setHoverIndex(null);
        }
      }}
    >
      {SERIES.map((series, i) => (
        <Panel
          key={series.key}
          days={days}
          series={series}
          width={width}
          hoverIndex={hoverIndex}
          withAxis={i === SERIES.length - 1}
        />
      ))}

      {/* One tooltip, both series: values lead, labels follow. */}
      {hovered && (
        <div
          className="pointer-events-none absolute top-2 z-10 w-40 rounded-md border border-foreground/10 bg-popover p-2 shadow-sm"
          style={{ left: tooltipLeft }}
        >
          <div className="text-xs text-muted-foreground">{shortDay(hovered.day)}</div>
          {SERIES.map((series) => (
            <div key={series.key} className="mt-1 flex items-center gap-1.5 text-xs">
              <span
                aria-hidden
                className="inline-block h-0.5 w-3 shrink-0 rounded-full"
                style={{ background: series.color }}
              />
              <span className="font-semibold tabular-nums">
                {hovered[series.key].toLocaleString("en-US")}
              </span>
              <span className="text-muted-foreground">{series.label.toLowerCase()}</span>
            </div>
          ))}
        </div>
      )}

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">
          Daily numbers as a table
        </summary>
        <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-foreground/10">
          <table className="w-full">
            <thead className="sticky top-0 bg-muted/40">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Day</th>
                <th className="px-2 py-1 text-right font-medium">Clicks</th>
                <th className="px-2 py-1 text-right font-medium">Impressions</th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day} className="border-t border-foreground/10">
                  <td className="px-2 py-1 tabular-nums">{formatDay(d.day)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{d.clicks.toLocaleString("en-US")}</td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {d.impressions.toLocaleString("en-US")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

// The attendance gauge's drawing, as numbers — and what it says in words.
//
// Pure, so the arcs and the status line can be tested without rendering: the
// gauge is only ever a picture of a percentage that `attendance-analytics`
// already computed, and this file must never become a second place that
// decides what a percentage is.

/** The gauge's coordinate space: a half circle, centre (100, 100), radius 80. */
export const GAUGE_VIEWBOX = "0 0 200 124";
const CX = 100;
const CY = 100;
const R = 80;

export interface GaugePoint {
  x: number;
  y: number;
}

/** A point on the arc, `fraction` of the way from the left end (0) to the right (1). */
export function gaugePoint(fraction: number, radius = R): GaugePoint {
  const angle = Math.PI * (1 - clamp01(fraction));
  return {
    x: round(CX + radius * Math.cos(angle)),
    y: round(CY - radius * Math.sin(angle)),
  };
}

export interface GaugeGeometry {
  /** The whole half circle, drawn as the empty track. */
  track: string;
  /** The filled part, up to the percentage — null when there is no percentage yet. */
  value: string | null;
  /** Where the filled part ends; the marker sits here. */
  end: GaugePoint | null;
  /** A short tick across the arc at the institution's minimum. */
  threshold: { from: GaugePoint; to: GaugePoint };
}

export function gaugeGeometry(percentage: number | null, threshold: number): GaugeGeometry {
  const start = gaugePoint(0);
  const track = arc(start, gaugePoint(1));
  const fraction = percentage === null ? null : clamp01(percentage / 100);
  const end = fraction === null ? null : gaugePoint(fraction);
  // A zero-length arc draws nothing, and a marker at the very start still
  // shows where the reading is.
  const value = end && fraction !== null && fraction > 0 ? arc(start, end) : null;
  const t = clamp01(threshold / 100);
  return {
    track,
    value,
    end,
    threshold: { from: gaugePoint(t, R - 13), to: gaugePoint(t, R + 13) },
  };
}

export type GaugeTone = "neutral" | "positive" | "warning" | "negative";

/**
 * The gauge's reading in words, for everyone and not only those who can tell
 * green from red. The tone ladder is `rateTone`'s — at or above the minimum is
 * fine, above two thirds of it is a warning, below that is serious — and
 * `null` is no attendance yet, which is nobody's fault.
 */
export function gaugeStatus(
  percentage: number | null,
  threshold: number,
): { tone: GaugeTone; label: string } {
  if (percentage === null) return { tone: "neutral", label: "No classes recorded yet" };
  if (percentage >= threshold) {
    return { tone: "positive", label: `At or above the ${formatNumber(threshold)}% minimum` };
  }
  return {
    tone: percentage >= threshold * (2 / 3) ? "warning" : "negative",
    label: `Below the ${formatNumber(threshold)}% minimum`,
  };
}

/** "87.5%" — one decimal place, as every other attendance figure in the app. */
export function formatGaugePercentage(percentage: number | null): string {
  return percentage === null ? "—" : `${percentage.toFixed(1)}%`;
}

function arc(from: GaugePoint, to: GaugePoint): string {
  // Never more than half a circle, drawn clockwise over the top.
  return `M ${from.x} ${from.y} A ${R} ${R} 0 0 1 ${to.x} ${to.y}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

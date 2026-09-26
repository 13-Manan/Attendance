import {
  GAUGE_VIEWBOX,
  formatGaugePercentage,
  gaugeGeometry,
  gaugeStatus,
  gaugePoint,
  type GaugeTone,
} from "./gauge-geometry";

/**
 * Overall attendance as a gauge: the percentage large in the middle, the arc
 * filled to it, and a tick where the institution's minimum sits.
 *
 * A picture of a number, not a source of one — the percentage is the one
 * `attendance-analytics` computed for the register and the reports alike.
 * Nothing moves: the reading is on screen the moment the page is. The drawing
 * is decorative; the figure's accessible name, and the line beneath it, say
 * the same thing in words, so nothing depends on seeing the colour.
 */
const ARC_TONE: Record<GaugeTone, string> = {
  neutral: "stroke-neutral-300",
  positive: "stroke-emerald-500",
  warning: "stroke-amber-500",
  negative: "stroke-red-500",
};

const TEXT_TONE: Record<GaugeTone, string> = {
  neutral: "text-neutral-500",
  positive: "text-emerald-700",
  warning: "text-amber-700",
  negative: "text-red-700",
};

const MARK: Record<GaugeTone, string> = {
  neutral: "–",
  positive: "✓",
  warning: "!",
  negative: "!",
};

export function AttendanceGauge({
  percentage,
  threshold,
  label = "Overall attendance",
}: {
  percentage: number | null;
  threshold: number;
  label?: string;
}) {
  const geometry = gaugeGeometry(percentage, threshold);
  const status = gaugeStatus(percentage, threshold);
  const reading = formatGaugePercentage(percentage);
  const spoken =
    percentage === null
      ? `${label}: no classes recorded yet.`
      : `${label}: ${percentage.toFixed(1)} percent. ${status.label}.`;
  const left = gaugePoint(0);
  const right = gaugePoint(1);

  return (
    <figure role="img" aria-label={spoken} className="flex w-full flex-col items-center gap-1">
      <svg viewBox={GAUGE_VIEWBOX} className="w-full max-w-72" aria-hidden focusable="false">
        <path
          d={geometry.track}
          fill="none"
          strokeWidth={14}
          strokeLinecap="round"
          className="stroke-neutral-200"
        />
        {geometry.value ? (
          <path
            d={geometry.value}
            fill="none"
            strokeWidth={14}
            strokeLinecap="round"
            className={ARC_TONE[status.tone]}
          />
        ) : null}
        <line
          x1={geometry.threshold.from.x}
          y1={geometry.threshold.from.y}
          x2={geometry.threshold.to.x}
          y2={geometry.threshold.to.y}
          strokeWidth={2.5}
          strokeLinecap="round"
          className="stroke-neutral-600"
        />
        {geometry.end ? (
          <circle
            cx={geometry.end.x}
            cy={geometry.end.y}
            r={9}
            strokeWidth={4}
            className={`fill-white ${ARC_TONE[status.tone]}`}
          />
        ) : null}
        {/* Sized to the reading so "100.0%" stays inside the arc like "87.5%". */}
        <text
          x={100}
          y={88}
          textAnchor="middle"
          className={`fill-neutral-900 font-semibold tabular-nums ${
            reading.length > 5 ? "text-[28px]" : "text-[32px]"
          }`}
        >
          {reading}
        </text>
        <text
          x={100}
          y={106}
          textAnchor="middle"
          className="fill-neutral-500 text-[10px] font-semibold uppercase tracking-[0.18em]"
        >
          Attendance
        </text>
        <text x={left.x} y={119} textAnchor="middle" className="fill-neutral-400 text-[9px]">
          0%
        </text>
        <text x={right.x} y={119} textAnchor="middle" className="fill-neutral-400 text-[9px]">
          100%
        </text>
      </svg>
      <figcaption className={`flex items-center gap-1.5 text-sm font-medium ${TEXT_TONE[status.tone]}`}>
        <span aria-hidden>{MARK[status.tone]}</span>
        {status.label}
      </figcaption>
    </figure>
  );
}

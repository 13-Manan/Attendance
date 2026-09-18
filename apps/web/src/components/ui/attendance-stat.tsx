import type { CorrectionSource } from "@/modules/attendance/types";
import type { AttendanceRate } from "@/modules/attendance-analytics/types";
import { DEFAULT_LOW_ATTENDANCE_THRESHOLD } from "@/modules/institutions/types";

const RESULT_CLASSES: Record<string, string> = {
  PRESENT: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  ABSENT: "bg-red-50 text-red-700 ring-red-200",
  NEEDS_REVIEW: "bg-amber-50 text-amber-800 ring-amber-200",
  NOT_EVALUATED: "bg-neutral-100 text-neutral-600 ring-neutral-200",
};

const RESULT_LABELS: Record<string, string> = {
  PRESENT: "Present",
  ABSENT: "Absent",
  NEEDS_REVIEW: "Needs review",
  NOT_EVALUATED: "Needs review",
};

/**
 * An attendance result, as a student or faculty member reads it.
 *
 * `NOT_EVALUATED` is shown as "Needs review" on purpose: the distinction
 * between "the model was uncertain" and "the model never ran" matters to the
 * engine, but to a reader both mean the same thing — a human still owes this
 * row a decision. The review board explains which it was.
 */
export function ResultBadge({ result }: { result: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
        RESULT_CLASSES[result] ?? RESULT_CLASSES.NOT_EVALUATED
      }`}
    >
      {RESULT_LABELS[result] ?? result}
    </span>
  );
}

/**
 * Where a correction came from.
 *
 * Keyed on the enum rather than `string`, so adding a `CorrectionSource`
 * is a compile error here instead of a raw `PUBLIC_API` turning up in
 * somebody's attendance history.
 */
const CORRECTION_SOURCE_LABELS: Record<CorrectionSource, string> = {
  FACULTY_REVIEW: "Faculty review",
  ROLL_CALL: "Roll call",
  ADMIN_OVERRIDE: "Administrative correction",
  PUBLIC_API: "External system",
};

export function correctionSourceLabel(source: string): string {
  return CORRECTION_SOURCE_LABELS[source as CorrectionSource] ?? source;
}

/**
 * A percentage, or an honest dash.
 *
 * `null` means there is no attendance to compute a percentage from. It is
 * rendered as "—", never as 0%: telling a student with no classes yet that
 * they are at 0% is a false statement about their record.
 */
export function RatePercent({
  rate,
  className = "",
}: {
  rate: AttendanceRate;
  className?: string;
}) {
  if (rate.percentage === null) {
    return (
      <span className={`text-neutral-400 ${className}`} title="No attendance recorded yet">
        —
      </span>
    );
  }
  return <span className={className}>{rate.percentage.toFixed(1)}%</span>;
}

/**
 * A horizontal proportion bar. Decorative — the numbers beside it are the
 * real content, so it is hidden from assistive technology.
 *
 * `threshold` is where the bar turns from amber to green, and it is the
 * institution's configured low-attendance rule, not a number this component
 * invents. It defaults rather than being required so that the handful of
 * places rendering a bar with no institution in scope keep working; anywhere
 * the threshold has been resolved, pass it, or the bar will call a student
 * comfortable who is in fact below their institution's line.
 */
export function RateBar({
  rate,
  threshold = DEFAULT_LOW_ATTENDANCE_THRESHOLD,
}: {
  rate: AttendanceRate;
  threshold?: number;
}) {
  const pct = rate.percentage ?? 0;
  // Two-thirds of the way to the threshold is "some way below", not a second
  // policy: scaling it off `threshold` keeps the amber band meaningful when an
  // institution runs an 80% or a 60% rule.
  const warnAt = threshold * (2 / 3);
  const tone = pct >= threshold ? "bg-emerald-500" : pct >= warnAt ? "bg-amber-500" : "bg-red-500";
  return (
    <div aria-hidden className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export type StatTone = "neutral" | "positive" | "warning" | "negative";

/**
 * Which tone a headline attendance percentage should carry.
 *
 * The same ladder as `RateBar`, extracted because two pages were each
 * spelling it out with their own literal. `null` — no attendance recorded —
 * is neutral, not negative: a student with no classes yet has not done
 * anything wrong.
 */
export function rateTone(
  percentage: number | null,
  threshold = DEFAULT_LOW_ATTENDANCE_THRESHOLD,
): StatTone {
  if (percentage === null) return "neutral";
  if (percentage >= threshold) return "positive";
  return percentage >= threshold * (2 / 3) ? "warning" : "negative";
}

/** One headline number. Stacks one-per-row on phones, four across on desktop. */
export function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: StatTone;
}) {
  const toneClass = {
    neutral: "text-neutral-900",
    positive: "text-emerald-700",
    warning: "text-amber-700",
    negative: "text-red-700",
  }[tone];
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-neutral-200 bg-white p-4">
      <span className="text-xs font-medium text-neutral-500">{label}</span>
      <span className={`text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</span>
      {hint ? <span className="text-xs text-neutral-500">{hint}</span> : null}
    </div>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
};

/**
 * Dates are formatted in UTC, matching the day boundary the attendance engine
 * uses to decide which calendar day a session belongs to. Rendering the same
 * timestamp in the viewer's local zone would put a late-evening class on the
 * "wrong" day relative to the register it came from.
 */
export function formatSessionDate(iso: string, opts: Intl.DateTimeFormatOptions = DATE_FORMAT) {
  return new Date(iso).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
}

export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

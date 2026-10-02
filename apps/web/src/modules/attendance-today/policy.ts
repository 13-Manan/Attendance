import type { SessionStatus } from "@/modules/sessions/types";
import type {
  TodayDate,
  TodayPlanKind,
  TodayRegister,
  TodayRegisterState,
  TodayRegisterView,
} from "./types";

/**
 * The Today card's decisions, without a database or a clock: what "today" is
 * called, where each register stands, which one to offer first, and where its
 * buttons go. Everything here is a pure function of what the server read.
 *
 * None of it authorizes anything. The links point at the existing capture and
 * review pages, which check the class and subject again exactly as they always
 * have — a register reaching this card is a suggestion of where to go, not
 * permission to go there.
 */

// ---------------------------------------------------------------------------
// Today's date, in the institution's own timezone
// ---------------------------------------------------------------------------

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Today's date as the institution's clock reads it.
 *
 * Production containers run in UTC, so formatting with the server's default
 * timezone would put an Indian school's early morning on yesterday's date. A
 * missing or unknown timezone falls back to UTC rather than failing the page.
 *
 * `locale` is left to the runtime by default, as everywhere else in the app;
 * tests pin it.
 */
export function institutionToday(
  now: Date,
  timeZone: string | null | undefined,
  locale?: string,
): TodayDate {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    iso: `${part("year")}-${part("month")}-${part("day")}`,
    long: new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(now),
    short: new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(now),
    timeZone: zone,
  };
}

/**
 * A moment as the institution's clock shows it — a register's date or start
 * time. Server-rendered pages would otherwise use the container's timezone,
 * which in production is UTC.
 */
export function formatInTimeZone(
  at: Date | string,
  timeZone: string | null | undefined,
  options: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }).format(new Date(at));
}

// ---------------------------------------------------------------------------
// Register state
// ---------------------------------------------------------------------------

/**
 * Today's session status, as the teacher thinks of it. A discarded session is
 * no register at all — Start opens a fresh one, exactly as the day's
 * uniqueness check treats it.
 */
export function registerStateOf(status: SessionStatus | null): TodayRegisterState {
  switch (status) {
    case "OPEN":
    case "CAPTURING":
    case "PROCESSING":
      return "in_progress";
    case "REVIEW":
      return "in_review";
    case "FINALIZED":
      return "done";
    case "CANCELLED":
    case null:
      return "not_started";
  }
}

/** Where today's register stands, in four words a teacher reads at a glance. */
export const STATUS_LABEL: Record<TodayRegisterState, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  in_review: "Needs review",
  done: "Completed",
};

/** The one thing to do next, named for what it does. */
const PRIMARY_LABEL: Record<Exclude<TodayRegisterState, "done">, string> = {
  not_started: "Take today's attendance",
  in_progress: "Continue attendance",
  in_review: "Review attendance",
};

// ---------------------------------------------------------------------------
// Which classes belong on today's card
// ---------------------------------------------------------------------------

export interface AcademicYearFlags {
  isActive: boolean;
  isCurrent: boolean;
}

/**
 * Today's attendance is for this academic year's classes. A school setting up
 * next year's sections in advance should not find them offered this morning.
 *
 * When the institution has marked a current year, only classes in it count.
 * When it has not, every class in an active year does — the card must not go
 * empty because a setting was never chosen. Either way the full class list
 * stays one tap away, and nothing here restricts what the capture page allows.
 */
export function relevantForToday<T>(
  classes: T[],
  institutionHasCurrentYear: boolean,
  yearOf: (item: T) => AcademicYearFlags,
): T[] {
  return classes.filter((c) => {
    const year = yearOf(c);
    return institutionHasCurrentYear ? year.isCurrent && year.isActive : year.isActive;
  });
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * The capture page for a register, told to start straight away. `start=1` is
 * the teacher's tap on the Today card carried across: it opens (or resumes)
 * today's register and the camera without a second "Start" press. The page
 * still authorizes the class and subject itself.
 */
export function captureHref(
  register: Pick<TodayRegister, "cohortId" | "cohortSubjectId">,
  from: "today" | "class" = "today",
): string {
  const params = new URLSearchParams();
  if (register.cohortSubjectId) params.set("subject", register.cohortSubjectId);
  params.set("start", "1");
  params.set("from", from);
  return `/dashboard/attendance/${encodeURIComponent(register.cohortId)}/capture?${params.toString()}`;
}

function reviewHref(cohortId: string, sessionId: string): string {
  return `/dashboard/attendance/${encodeURIComponent(cohortId)}/review/${encodeURIComponent(sessionId)}`;
}

function historyHref(cohortId: string): string {
  return `/dashboard/attendance/${encodeURIComponent(cohortId)}/history`;
}

export interface TodayViewOptions {
  /**
   * Whether this account can open a register for review. An attendance
   * operator captures but does not review, so for them a register in review
   * is finished business — "sent for review" — not a button to a page that
   * would turn them away.
   */
  canReview: boolean;
}

export function viewOf(
  register: TodayRegister,
  options: TodayViewOptions = { canReview: true },
): TodayRegisterView {
  const { state, sessionId } = register;
  let primary: TodayRegisterView["primary"] = null;
  if (state === "not_started" || state === "in_progress") {
    primary = { label: PRIMARY_LABEL[state], href: captureHref(register) };
  } else if (state === "in_review" && sessionId && options.canReview) {
    primary = { label: PRIMARY_LABEL.in_review, href: reviewHref(register.cohortId, sessionId) };
  }
  return {
    ...register,
    statusLabel:
      state === "in_review" && !options.canReview ? "Sent for review" : STATUS_LABEL[state],
    primary,
    // Once today's register is confirmed, the way to look at it. Before that
    // the big button already goes there (review), or there is nothing to see
    // yet (capture).
    viewToday:
      sessionId && options.canReview && state === "done"
        ? { label: "View attendance", href: reviewHref(register.cohortId, sessionId) }
        : null,
    history: { label: "Previous attendance", href: historyHref(register.cohortId) },
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Likeliest first: a register the teacher was in the middle of, then one not
 * yet started, then one waiting for review. Within that, their own class
 * (class teacher) before one they assist in, then by name.
 */
const STATE_ORDER: Record<TodayRegisterState, number> = {
  in_progress: 0,
  not_started: 1,
  in_review: 2,
  done: 3,
};

function byLikelihood(a: TodayRegister, b: TodayRegister): number {
  return (
    STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
    Number(b.isClassTeacher) - Number(a.isClassTeacher) ||
    a.className.localeCompare(b.className) ||
    (a.subjectName ?? "").localeCompare(b.subjectName ?? "")
  );
}

export interface TodayPlan {
  kind: TodayPlanKind;
  choices: TodayRegisterView[];
  selectedKey: string | null;
  done: TodayRegisterView[];
  withoutStudents: Array<{ key: string; className: string; subjectName: string | null }>;
}

/**
 * Asks only what the system cannot know. One register to act on: no question.
 * Several: one question, with the likeliest already selected. A class with no
 * students on roll has no register to take, so it is mentioned, not offered.
 */
export function planToday(
  registers: TodayRegister[],
  options: TodayViewOptions = { canReview: true },
): TodayPlan {
  const withoutStudents = registers.filter((r) => r.studentCount === 0 && r.state === "not_started");
  const takeable = registers.filter((r) => !withoutStudents.includes(r));
  // Nothing left for this account to do on a register in review it cannot open.
  const finished = (r: TodayRegister) => r.state === "done" || (r.state === "in_review" && !options.canReview);
  const view = (r: TodayRegister) => viewOf(r, options);

  const choices = takeable.filter((r) => !finished(r)).sort(byLikelihood).map(view);
  const done = takeable.filter(finished).sort(byLikelihood).map(view);

  const kind: TodayPlanKind =
    choices.length === 1
      ? "single"
      : choices.length > 1
        ? "choose"
        : done.length > 0
          ? "all_done"
          : "none";

  return {
    kind,
    choices,
    selectedKey: choices[0]?.key ?? null,
    done,
    withoutStudents: withoutStudents
      .sort(byLikelihood)
      .map((r) => ({ key: r.key, className: r.className, subjectName: r.subjectName })),
  };
}

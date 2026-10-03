"use client";

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertIcon, CheckIcon } from "@/components/attendance/icons";
import { Button } from "@/components/ui/button";
import { getAttendanceReviewBoardAction } from "@/modules/attendance-review/actions";
import { decideStudentFlow, finishAttendanceFlow } from "@/modules/attendance-review/flow-actions";
import {
  absentProvenance,
  describeReviewFlowError,
  evidenceOf,
  needAttentionWords,
  presentProvenance,
  reasonDetail,
  reviewButtonLabel,
  reviewSummaryOf,
  shortReason,
} from "@/modules/attendance-review/review-flow";
import type { AttendanceReviewBoard, AttendanceReviewStudent } from "@/modules/attendance-review/types";
import type { AttendanceRealtimeEvent } from "@/modules/realtime/types";
import { useLiveStream } from "@/modules/realtime/use-live-stream";
import { describeRecognitionAvailability } from "@/modules/recognition-engine/wording";

/**
 * The faculty review board.
 *
 * A recognised student is present — the register records it, and nothing is
 * asked of the teacher to keep it that way. The board leads with that count,
 * then with the students who were not confidently recognised: those, and only
 * those, wait for the teacher ("Needs attention", each with Present, Absent
 * and Review). Every present or absent row keeps an Edit. On a phone the
 * Present list folds away under its count; a wide screen shows it beside
 * Needs attention.
 *
 * Every decision is optimistic: the counts and lists move the instant a button
 * is pressed, because a teacher calling roll needs the tally to keep up. The
 * server's authoritative counts then replace the optimistic ones, so a refused
 * decision snaps back rather than lingering as a lie.
 *
 * What this screen will NOT do:
 *   - finish a register while anyone still needs the teacher (the server
 *     refuses too; the button says why)
 *   - hide a student recognition never compared (they wait in "Needs
 *     attention" with the reason on the row and the detail behind Review)
 *   - call anyone absent who was only not detected — that is the teacher's call
 *   - refetch the whole page on every event (SSE carries the delta)
 */

interface Props {
  initialBoard: AttendanceReviewBoard;
  /** Admins (`faceEmbedding.manage`) see which provider and model build ran;
   * teachers see what it means for them. */
  showDiagnostics?: boolean;
  /** Where "Add another photo" goes, or null when the caller cannot capture
   * for this session. Built on the server, which knows the permission. */
  addPhotoHref?: string | null;
}

type DecisionResult = "PRESENT" | "ABSENT" | "NEEDS_REVIEW";

/**
 * Name or roll-number search over one register.
 *
 * Matches on the full name in either order — a register is as often read
 * surname-first as given-name-first — and on the student code, which is what a
 * teacher reading off a printed list will type.
 */
function matchesQuery(student: AttendanceReviewStudent, needle: string): boolean {
  const first = student.firstName.toLowerCase();
  const last = student.lastName.toLowerCase();
  return (
    `${first} ${last}`.includes(needle) ||
    `${last} ${first}`.includes(needle) ||
    student.studentCode.toLowerCase().includes(needle)
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/**
 * Wide screens (1024px and up) show Present beside Needs attention, open; a
 * phone keeps it folded under its count. The server renders the phone layout,
 * and a wide screen opens the list once it has hydrated.
 */
const WIDE = "(min-width: 1024px)";
function useWideScreen(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(WIDE);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

function Avatar({ student }: { student: AttendanceReviewStudent }) {
  // `photoUrl` is always null in this build — Student carries no photo
  // column — so the monogram is the real rendering path, not a fallback.
  if (student.photoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={student.photoUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
    );
  }
  return (
    <span
      aria-hidden
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-xs font-semibold text-neutral-600"
    >
      {student.initials}
    </span>
  );
}

function Identity({ student, line }: { student: AttendanceReviewStudent; line?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar student={student} />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-neutral-900">
          {student.firstName} {student.lastName}
        </p>
        {/* Wraps rather than truncates: who decided must stay readable on a 320px phone. */}
        <p className="text-balance break-words text-xs text-neutral-500">
          {student.studentCode}
          {line ? ` · ${line}` : ""}
        </p>
      </div>
    </div>
  );
}

/**
 * A timestamp in the reader's own locale, without a hydration mismatch.
 *
 * `toLocaleString()` asks the runtime for its locale and timezone, and the
 * server's are not the reader's: this banner rendered "20/09/2026, 18:34:49"
 * on the server and "9/20/2026, 6:34:49 PM" in the browser, so React threw
 * away the tree and rebuilt it on every finalized register.
 *
 * So the server emits the ISO instant — stable, machine-readable, and what
 * `<time dateTime>` wants anyway — and the locale formatting happens after
 * mount, where the browser's own locale is the right one to use.
 */
function LocalTime({ iso }: { iso: string }) {
  const onClient = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  return <time dateTime={iso}>{onClient ? new Date(iso).toLocaleString() : iso}</time>;
}

/** Two equal choices — neither one looks already chosen. */
const CHOICE =
  "inline-flex min-h-12 items-center justify-center rounded-xl border border-neutral-300 bg-white px-4 text-sm font-semibold text-neutral-900 transition-colors hover:bg-neutral-50 active:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-neutral-400";

/** Review: as large as the two choices, quieter, because it decides nothing. */
const REVIEW_CHOICE =
  "inline-flex min-h-12 items-center justify-center rounded-xl border border-transparent bg-neutral-100 px-4 text-sm font-semibold text-neutral-800 transition-colors hover:bg-neutral-200 active:bg-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 aria-expanded:bg-neutral-200";

const SMALL_ACTION =
  "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md px-2 text-sm font-medium text-neutral-700 underline-offset-4 hover:text-neutral-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900";

// ---------------------------------------------------------------------------

export function ReviewBoard({ initialBoard, showDiagnostics = false, addPhotoHref = null }: Props) {
  const router = useRouter();
  const [board, setBoard] = useState(initialBoard);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");
  const [query, setQuery] = useState("");
  // null: whatever suits the screen (open on a wide one); a tap makes it the teacher's choice.
  const [open, setOpen] = useState<{ present: boolean | null; absent: boolean | null }>({ present: null, absent: null });
  const [editing, setEditing] = useState<string | null>(null);
  const [editReason, setEditReason] = useState("");
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [lastDecision, setLastDecision] = useState<{
    student: AttendanceReviewStudent;
    previous: DecisionResult;
    next: DecisionResult;
  } | null>(null);
  const attentionHeading = useRef<HTMLHeadingElement | null>(null);
  const wide = useWideScreen();

  const sessionId = board.session.id;
  const isFinalized = board.session.processingStatus === "FINALIZED";
  const canEdit = board.actorCanCorrect && (!isFinalized || board.actorCanOverrideFinalized);
  const summary = reviewSummaryOf(board);

  // -------------------------------------------------------------------------
  // Realtime. One SSE connection per open board; each event carries the
  // changed record and the authoritative counts, so a second teacher's
  // correction lands here without anybody refetching the page.
  // -------------------------------------------------------------------------
  /**
   * Guards against an older board landing after a newer one: a reconnect
   * reconciliation and an event-driven refresh can overlap, and the later
   * request is the newer truth.
   */
  const latestRefresh = useRef(0);

  const refresh = useCallback(async () => {
    const ticket = ++latestRefresh.current;
    try {
      const next = await getAttendanceReviewBoardAction({ sessionId });
      if (ticket !== latestRefresh.current) return;
      setBoard(next);
    } catch {
      // A failed background refresh must not clobber a usable screen. The
      // next event (or the user's next action) will reconcile.
    }
  }, [sessionId]);

  const handleEvent = useCallback(
    (event: AttendanceRealtimeEvent) => {
      if (event.type === "attendance-record-updated") {
        setBoard((current) => ({ ...current, counts: event.counts }));
        void refresh();
      } else if (event.type === "attendance-session-finalized") {
        setLiveMessage("This attendance was finished.");
        void refresh();
      }
    },
    [refresh],
  );

  const { state: connection } = useLiveStream<AttendanceRealtimeEvent>({
    url: `/api/realtime/attendance/${sessionId}`,
    onEvent: handleEvent,
    // The board may have moved while this screen was disconnected — a second
    // teacher deciding, or the register being finished. Re-read rather than
    // leave a stale roster in front of the room.
    onReconnect: refresh,
  });

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------
  const decide = useCallback(
    async (
      student: AttendanceReviewStudent,
      newResult: DecisionResult,
      options: { reason?: string; undo?: boolean } = {},
    ) => {
      const id = student.attendanceRecordId;
      setError(null);
      setRowError((e) => {
        const next = { ...e };
        delete next[id];
        return next;
      });
      setPending((p) => ({ ...p, [id]: true }));

      const previous = board;
      // Optimistic move: the student leaves their current list, joins the new
      // one, and the counts update in the same render.
      setBoard((current) => moveStudent(current, id, newResult));

      try {
        const result = await decideStudentFlow({
          attendanceRecordId: id,
          newResult,
          ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
        });
        if (!result.ok) {
          // Snap back — a decision the server refused must not appear to
          // have happened.
          setBoard(previous);
          setRowError((e) => ({ ...e, [id]: describeReviewFlowError(result.code) }));
          if (result.code === "register_changed") void refresh();
          return;
        }
        setBoard((current) => ({ ...current, counts: result.value.counts }));
        const name = `${student.firstName} ${student.lastName}`;
        setLiveMessage(
          newResult === "NEEDS_REVIEW"
            ? `${name} needs attention again.`
            : `${name} marked ${newResult === "PRESENT" ? "present" : "absent"}.`,
        );
        setEditing(null);
        setEditReason("");
        setLastDecision(
          options.undo || isFinalized
            ? null
            : { student: { ...student }, previous: student.finalResult === "PRESENT" || student.finalResult === "ABSENT" ? student.finalResult : "NEEDS_REVIEW", next: newResult },
        );
        void refresh();
      } catch {
        // The request itself failed — the connection, usually.
        setBoard(previous);
        setRowError((e) => ({ ...e, [id]: "Couldn't save that — check the connection and try again." }));
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[id];
          return next;
        });
      }
    },
    [board, isFinalized, refresh],
  );

  const undo = useCallback(() => {
    if (!lastDecision) return;
    const { student, previous } = lastDecision;
    setLastDecision(null);
    void decide({ ...student, finalResult: lastDecision.next }, previous, { undo: true });
  }, [decide, lastDecision]);

  const finish = useCallback(async () => {
    setError(null);
    setConfirming(true);
    try {
      const result = await finishAttendanceFlow({ sessionId });
      if (!result.ok) {
        setError(describeReviewFlowError(result.code));
        void refresh();
        return;
      }
      setConfirmOpen(false);
      setLastDecision(null);
      await refresh();
      router.refresh();
    } catch {
      setError("Couldn't finish attendance — check the connection and try again.");
    } finally {
      setConfirming(false);
    }
  }, [refresh, router, sessionId]);

  const goToAttention = useCallback(() => {
    const heading = attentionHeading.current;
    if (!heading) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    heading.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    heading.focus({ preventScroll: true });
  }, []);

  // -------------------------------------------------------------------------
  // Search. Changes what is *displayed*, never what is counted: the summary
  // stays the register's real tally, and finishing is the server's call.
  // -------------------------------------------------------------------------
  const needle = query.trim().toLowerCase();
  const filtering = needle.length > 0;
  const shownAttention = useMemo(
    () => (needle ? board.needsReview.filter((s) => matchesQuery(s, needle)) : board.needsReview),
    [board.needsReview, needle],
  );
  const shownAbsent = useMemo(
    () => (needle ? board.absent.filter((s) => matchesQuery(s, needle)) : board.absent),
    [board.absent, needle],
  );
  const shownPresent = useMemo(
    () => (needle ? board.present.filter((s) => matchesQuery(s, needle)) : board.present),
    [board.present, needle],
  );
  const matchCount = shownAttention.length + shownAbsent.length + shownPresent.length;
  const presentOpen = filtering || (open.present ?? wide);
  const absentOpen = filtering || (open.absent ?? wide);

  const provenance = useMemo(() => {
    const s = board.session;
    const bits: string[] = [];
    if (s.generationSource === "manual") {
      bits.push("Taken by hand — face matching did not contribute");
    } else if (s.recognition) {
      if (showDiagnostics) bits.push(`${s.recognition.modelName} ${s.recognition.modelVersion}`);
      bits.push(
        `${s.recognition.scoredFacesTotal} of ${s.recognition.detectedFacesTotal} faces checked against ${plural(s.recognition.candidatePoolSize, "student")}`,
      );
      const unknown = s.recognition.unknownFacesTotal ?? 0;
      if (unknown > 0) bits.push(`${plural(unknown, "face")} matched nobody`);
      const rounds = s.recognition.rounds ?? 1;
      if (rounds > 1) bits.push(`${rounds} rounds of photos merged`);
    }
    if (s.captureImages.length > 0) bits.push(plural(s.captureImages.length, "photo"));
    return bits.join(" · ");
  }, [board.session, showDiagnostics]);

  const availability = board.session.recognition
    ? describeRecognitionAvailability(board.session.recognition, { showDiagnostics })
    : null;

  // -------------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------------
  const errorFor = (student: AttendanceReviewStudent) =>
    rowError[student.attendanceRecordId] ? (
      <p role="alert" className="px-4 pb-3 text-sm text-red-700 sm:pl-16">
        {rowError[student.attendanceRecordId]}
      </p>
    ) : null;

  const editRow = (student: AttendanceReviewStudent, to: "PRESENT" | "ABSENT") => {
    const id = student.attendanceRecordId;
    if (editing !== id) return null;
    return (
      <div className="flex flex-col gap-2 px-4 pb-3 sm:flex-row sm:items-center sm:pl-16">
        {isFinalized ? (
          <>
            <label htmlFor={`reason-${id}`} className="sr-only">
              Reason for the change
            </label>
            <input
              id={`reason-${id}`}
              value={editReason}
              onChange={(e) => setEditReason(e.target.value)}
              maxLength={500}
              placeholder="Reason (if your school asks for one)"
              className="min-h-11 rounded-lg border border-neutral-300 px-3 text-sm sm:flex-1"
            />
          </>
        ) : null}
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Button
            onClick={() => void decide(student, to, { reason: editReason })}
            disabled={pending[id]}
          >
            {to === "ABSENT" ? "Mark absent" : "Mark present"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setEditing(null);
              setEditReason("");
            }}
            disabled={pending[id]}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className={`flex flex-col gap-4 md:pb-0 ${isFinalized ? "" : "pb-40"}`}>
      <p aria-live="polite" className="sr-only">
        {liveMessage}
      </p>

      {availability && availability.availability !== "ready" && (
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>{availability.headline}.</strong> {availability.detail}
          {availability.diagnostics && (
            <span className="mt-1 block font-mono text-[11px] text-neutral-500">{availability.diagnostics}</span>
          )}
        </div>
      )}
      {availability?.availability === "ready" && availability.diagnostics && (
        <p className="font-mono text-[11px] text-neutral-500">{availability.diagnostics}</p>
      )}

      {/*
        Only once a live connection has been lost, never on first load and
        never per retry: a teacher reading this board to a room needs to know
        when it has stopped being live. Stated in words, not by colour alone.
      */}
      {connection === "reconnecting" && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>Live updates interrupted.</strong> Reconnecting — this board will refresh
          itself once the connection returns.
        </div>
      )}
      {connection === "unauthorized" && (
        <div role="status" className="rounded-lg border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
          <strong>Live updates have stopped.</strong> Reload the page to sign in again.
        </div>
      )}

      {isFinalized && (
        <div className="rounded-lg border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
          <strong>Attendance finished</strong>
          {board.session.finalizedByName ? ` by ${board.session.finalizedByName}` : ""}
          {board.session.finalizedAt ? (
            <>
              {" on "}
              <LocalTime iso={board.session.finalizedAt} />
            </>
          ) : null}
          . Students can now see their result.
          {board.actorCanOverrideFinalized
            ? " You can still correct a record; every change is recorded as an authorized override."
            : " Corrections now need an administrator."}
        </div>
      )}

      {/* The summary: who is present, then who needs the teacher — counts first, in words and icons, never colour alone. */}
      <section aria-label="Attendance summary" className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
            <CheckIcon className="size-6" />
          </span>
          <p className="text-neutral-900">
            <span className="text-3xl font-semibold tabular-nums">{summary.present}</span>{" "}
            <span className="text-lg font-medium">Present</span>
          </p>
          {summary.absent > 0 ? (
            <p className="ml-auto text-sm text-neutral-600">{summary.absent} absent</p>
          ) : null}
        </div>
        <div className="my-4 border-t border-neutral-200" />
        {summary.attention > 0 ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-700">
                <AlertIcon className="size-6" />
              </span>
              <p className="text-neutral-900">
                <span className="text-3xl font-semibold tabular-nums">{summary.attention}</span>{" "}
                <span className="text-lg font-medium">{needAttentionWords(summary.attention)}</span>
              </p>
            </div>
            <button
              type="button"
              onClick={goToAttention}
              className="inline-flex min-h-12 items-center justify-center rounded-xl bg-neutral-900 px-5 text-base font-semibold text-white transition-colors hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2"
            >
              {reviewButtonLabel(summary.attention)}
            </button>
          </div>
        ) : (
          <p className="text-sm text-neutral-700">
            {isFinalized
              ? "Attendance is finished."
              : summary.total === 0
                ? "No register yet."
                : "Everyone is accounted for. Finish attendance when you're ready."}
          </p>
        )}
        {summary.legacySuggestions > 0 && !isFinalized ? (
          <p className="mt-3 text-xs text-neutral-600">
            {plural(summary.legacySuggestions, "recognised student")} {summary.legacySuggestions === 1 ? "is" : "are"} recorded as
            present when you finish.
          </p>
        ) : null}
        {!isFinalized && addPhotoHref ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 text-sm text-neutral-600">
            <span>
              {board.session.recognition?.recommendRetake
                ? "Some faces were too small to recognise. A closer photo can resolve them."
                : "Missed someone?"}
            </span>
            <Link href={addPhotoHref} className={SMALL_ACTION}>
              Add another photo
            </Link>
          </div>
        ) : null}
      </section>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      )}

      {lastDecision && !isFinalized ? (
        <div role="status" className="flex items-center justify-between gap-3 rounded-lg bg-neutral-100 px-3 py-1 text-sm text-neutral-800">
          <span className="min-w-0 truncate">
            {lastDecision.student.firstName} {lastDecision.student.lastName} marked{" "}
            {lastDecision.next === "PRESENT" ? "present" : lastDecision.next === "ABSENT" ? "absent" : "for attention"}.
          </span>
          <button type="button" onClick={undo} className={SMALL_ACTION}>
            Undo
          </button>
        </div>
      ) : null}

      {/*
        One column on a phone: Needs attention, then the folded Present and
        Absent lists. From 1024px: Present on the left, Needs attention and
        Absent on the right. The reading order stays attention-first either
        way, which is the order a screen reader hears.
      */}
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:grid-rows-[auto_1fr] lg:items-start lg:gap-x-6 lg:gap-y-4">
        {/* Needs attention: the only list that asks anything of the teacher. */}
        {!isFinalized || board.needsReview.length > 0 || filtering ? (
          <section
            aria-labelledby="attention-heading"
            className={`overflow-hidden rounded-2xl border border-amber-200 bg-white lg:col-start-2 lg:row-start-1 ${
              board.needsReview.length === 0 && !filtering ? "hidden lg:block" : ""
            }`}
          >
            <header className="flex items-center justify-between gap-3 border-b border-amber-100 bg-amber-50 px-4 py-2.5">
              <h2
                id="attention-heading"
                ref={attentionHeading}
                tabIndex={-1}
                className="flex items-center gap-2 text-sm font-semibold text-amber-900 focus:outline-none"
              >
                <AlertIcon className="size-4" />
                Needs attention
              </h2>
              <span className="text-xs tabular-nums text-amber-900">
                {filtering && shownAttention.length !== board.needsReview.length
                  ? `${shownAttention.length} of ${board.needsReview.length}`
                  : board.needsReview.length}
              </span>
            </header>
            {shownAttention.length === 0 ? (
              <p className="px-4 py-3 text-sm text-neutral-500">
                {board.needsReview.length > 0 ? "No student here matches your search." : "Nothing needs your attention."}
              </p>
            ) : (
              <ul className="divide-y divide-neutral-100">
                {shownAttention.map((student) => {
                  const id = student.attendanceRecordId;
                  const evidence = evidenceOf(student);
                  return (
                    <li key={id}>
                      <div className="flex flex-col gap-3 px-4 py-3">
                        <div className="min-w-0">
                          <Identity student={student} />
                          <p className="mt-1 pl-12 text-sm text-neutral-700">
                            <span className="font-medium text-neutral-900">Reason:</span> {shortReason(student.reason)}
                          </p>
                        </div>
                        <div className={`grid gap-2 ${canEdit ? "grid-cols-3" : "grid-cols-1"}`}>
                          {canEdit ? (
                            <>
                              <button
                                type="button"
                                className={CHOICE}
                                onClick={() => void decide(student, "PRESENT")}
                                disabled={pending[id]}
                                aria-label={`Present: ${student.firstName} ${student.lastName}`}
                              >
                                Present
                              </button>
                              <button
                                type="button"
                                className={CHOICE}
                                onClick={() => void decide(student, "ABSENT")}
                                disabled={pending[id]}
                                aria-label={`Absent: ${student.firstName} ${student.lastName}`}
                              >
                                Absent
                              </button>
                            </>
                          ) : null}
                          <button
                            type="button"
                            className={REVIEW_CHOICE}
                            onClick={() => setReviewing((r) => (r === id ? null : id))}
                            aria-expanded={reviewing === id}
                            aria-controls={`review-${id}`}
                            aria-label={`Review ${student.firstName} ${student.lastName}`}
                          >
                            Review
                          </button>
                        </div>
                      </div>
                      {reviewing === id ? (
                        <div id={`review-${id}`} className="mx-4 mb-3 rounded-xl bg-neutral-50 px-3 py-2.5 text-sm text-neutral-700">
                          <p>{reasonDetail(student.reason)}</p>
                          {evidence.length > 0 ? (
                            <ul className="mt-1.5 flex flex-col gap-0.5 text-xs text-neutral-500">
                              {evidence.map((line) => (
                                <li key={line}>{line}</li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      ) : null}
                      {errorFor(student)}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}

        {/* Present, behind its count: nothing in it asks anything of the teacher. */}
        <div className="flex flex-col gap-4 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          {summary.total > 0 && (
            <div className="flex flex-col gap-1">
              <label htmlFor="student-search" className="sr-only">
                Find a student by name or roll number
              </label>
              <input
                id="student-search"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a student"
                autoComplete="off"
                className="min-h-11 w-full rounded-lg border border-neutral-300 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none sm:max-w-xs lg:max-w-none"
              />
              {filtering ? (
                <p aria-live="polite" className="text-xs text-neutral-500">
                  {matchCount === 0
                    ? `No student matches “${query.trim()}”.`
                    : `${matchCount} of ${summary.total} students match. The counts above are for the whole register.`}
                </p>
              ) : null}
            </div>
          )}

          <Collapsible
            title="Present"
            icon={<CheckIcon className="size-4 text-emerald-700" />}
            count={board.present.length}
            shown={shownPresent.length}
            filtering={filtering}
            open={presentOpen}
            onToggle={() => setOpen((o) => ({ ...o, present: !(o.present ?? wide) }))}
            emptyText="Nobody is present yet."
          >
            {shownPresent.map((student) => (
              <li key={student.attendanceRecordId}>
                <div className="flex items-center justify-between gap-3 px-4 py-2">
                  <Identity student={student} line={presentProvenance(student)} />
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => {
                        setEditing((e) => (e === student.attendanceRecordId ? null : student.attendanceRecordId));
                        setEditReason("");
                      }}
                      aria-expanded={editing === student.attendanceRecordId}
                      aria-label={`Edit ${student.firstName} ${student.lastName}`}
                      className={SMALL_ACTION}
                    >
                      Edit
                    </button>
                  ) : null}
                </div>
                {editRow(student, "ABSENT")}
                {errorFor(student)}
              </li>
            ))}
          </Collapsible>
        </div>

        <div className="lg:col-start-2 lg:row-start-2">
          <Collapsible
            title="Absent"
            count={board.absent.length}
            shown={shownAbsent.length}
            filtering={filtering}
            open={absentOpen}
            onToggle={() => setOpen((o) => ({ ...o, absent: !(o.absent ?? wide) }))}
            emptyText="Nobody is marked absent."
          >
            {shownAbsent.map((student) => (
              <li key={student.attendanceRecordId}>
                <div className="flex items-center justify-between gap-3 px-4 py-2">
                  <Identity student={student} line={absentProvenance(student)} />
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => {
                        setEditing((e) => (e === student.attendanceRecordId ? null : student.attendanceRecordId));
                        setEditReason("");
                      }}
                      aria-expanded={editing === student.attendanceRecordId}
                      aria-label={`Edit ${student.firstName} ${student.lastName}`}
                      className={SMALL_ACTION}
                    >
                      Edit
                    </button>
                  ) : null}
                </div>
                {editRow(student, "PRESENT")}
                {errorFor(student)}
              </li>
            ))}
          </Collapsible>
        </div>
      </div>

      {provenance && <p className="text-xs text-neutral-500">{provenance}</p>}

      {/* Finishing: pinned within the thumb's reach on a phone; on a wider screen it rides the bottom of the board. */}
      {!isFinalized && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-neutral-200 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgba(0,0,0,0.06)] md:sticky md:bottom-4 md:z-10 md:rounded-2xl md:border md:p-4 md:shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
          {confirmOpen ? (
            <div role="group" aria-label="Finish attendance" className="flex flex-col gap-3">
              <p className="text-base font-semibold text-neutral-900">Finish today&apos;s attendance?</p>
              <p className="text-sm text-neutral-700">
                {summary.present} present · {summary.absent} absent. Students can then see their
                attendance; you can still correct a record afterwards.
              </p>
              <div className="grid grid-cols-2 gap-2 sm:flex">
                <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={confirming}>
                  Not yet
                </Button>
                <Button onClick={() => void finish()} disabled={!summary.canFinish || confirming}>
                  {confirming ? "Finishing…" : "Finish attendance"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={!summary.canFinish}
                className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-neutral-900 px-5 text-base font-semibold text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 sm:w-auto"
              >
                Finish attendance
              </button>
              {summary.finishBlockedReason ? (
                <p className="text-center text-sm text-neutral-600 sm:text-left">{summary.finishBlockedReason}</p>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Collapsible({
  title,
  icon,
  count,
  shown,
  filtering,
  open,
  onToggle,
  emptyText,
  children,
}: {
  title: string;
  /** Decorative; the title says it in words. */
  icon?: React.ReactNode;
  /** How many students are really in this list. */
  count: number;
  /** How many survive the current search. Equals `count` when not searching. */
  shown: number;
  filtering: boolean;
  open: boolean;
  onToggle: () => void;
  emptyText: string;
  children: React.ReactNode;
}) {
  const id = `list-${title.toLowerCase()}`;
  return (
    <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white">
      <h2>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={id}
          disabled={filtering}
          className="flex min-h-12 w-full items-center justify-between gap-3 px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neutral-900"
        >
          <span className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
            {icon}
            {title}
          </span>
          <span className="flex items-center gap-2 text-sm tabular-nums text-neutral-600">
            {/* "2 of 43" while searching: never mistaken for the size of the list. */}
            {filtering && shown !== count ? `${shown} of ${count}` : count}
            <span aria-hidden className={`text-neutral-400 transition-transform ${open ? "rotate-180" : ""}`}>
              ▾
            </span>
          </span>
        </button>
      </h2>
      {open ? (
        <div id={id} className="border-t border-neutral-100">
          {shown === 0 ? (
            <p className="px-4 py-3 text-sm text-neutral-500">
              {count > 0 ? "No student here matches your search." : emptyText}
            </p>
          ) : (
            <ul className="divide-y divide-neutral-100">{children}</ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Optimistic list surgery. Moves one record between the three lists and
 * recomputes the counts from the lists themselves, so the displayed tally can
 * never disagree with the displayed rows.
 */
function moveStudent(
  board: AttendanceReviewBoard,
  attendanceRecordId: string,
  newResult: DecisionResult,
): AttendanceReviewBoard {
  const all = [...board.present, ...board.absent, ...board.needsReview];
  const target = all.find((s) => s.attendanceRecordId === attendanceRecordId);
  if (!target) return board;

  const moved: AttendanceReviewStudent = {
    ...target,
    finalResult: newResult,
    isManuallyCorrected: true,
    reason: "manually_corrected",
  };
  const rest = all.filter((s) => s.attendanceRecordId !== attendanceRecordId);
  const byName = (a: AttendanceReviewStudent, b: AttendanceReviewStudent) =>
    a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);

  // The same grouping rule the server applies. A register written before
  // recognised students were recorded present still holds suggestions, which
  // belong with Present; splitting on `finalResult` alone would fling them
  // into "Needs attention" for the moment between the tap and the refresh.
  const unresolved = (s: AttendanceReviewStudent) =>
    s.finalResult === "NEEDS_REVIEW" || s.finalResult === "NOT_EVALUATED";
  const suggestedPresent = (s: AttendanceReviewStudent) =>
    unresolved(s) && s.aiSuggestion === "PRESENT" && !s.isManuallyCorrected;

  const present = rest.filter((s) => s.finalResult === "PRESENT" || suggestedPresent(s));
  const absent = rest.filter((s) => s.finalResult === "ABSENT");
  const needsReview = rest.filter((s) => unresolved(s) && !suggestedPresent(s));
  if (newResult === "PRESENT") present.push(moved);
  else if (newResult === "ABSENT") absent.push(moved);
  else needsReview.push(moved);

  present.sort(byName);
  absent.sort(byName);
  needsReview.sort(byName);

  // Whether it can be finished, as the server will say on the next refresh:
  // nobody left to decide, in review, and somebody on the register.
  const canFinalize =
    needsReview.length === 0 &&
    board.session.processingStatus === "REVIEW" &&
    present.length + absent.length > 0;

  return {
    ...board,
    present,
    absent,
    needsReview,
    awaitingDecision: needsReview.length,
    canFinalize,
    finalizeBlockedReason: canFinalize ? null : board.finalizeBlockedReason,
    counts: {
      total: present.length + absent.length + needsReview.length,
      present: present.filter((s) => s.finalResult === "PRESENT").length,
      absent: absent.length,
      needsReview: needsReview.length,
      notEvaluated: 0,
    },
  };
}

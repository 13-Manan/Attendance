"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  confirmAttendanceAction,
  getAttendanceReviewBoardAction,
  submitReviewDecisionAction,
} from "@/modules/attendance-review/actions";
import type {
  AttendanceReviewBoard,
  AttendanceReviewReason,
  AttendanceReviewStudent,
} from "@/modules/attendance-review/types";
import type { AttendanceRealtimeEvent } from "@/modules/realtime/types";

/**
 * Phase 6 faculty review board.
 *
 * Three lists — Present, Absent, Needs Review — over one register. Every
 * correction is optimistic: the counters and the lists move the instant the
 * button is pressed, because a teacher calling roll needs the tally to keep
 * up with them. The server's authoritative counts then replace the optimistic
 * ones, so a rejected correction snaps back rather than lingering as a lie.
 *
 * What this screen will NOT do:
 *   - promote an unresolved review row by omission (Confirm is disabled and
 *     says why)
 *   - hide a student who recognition never compared (they sit in Needs
 *     Review with the reason spelled out)
 *   - refetch the whole page on every event (SSE carries the delta)
 */

interface Props {
  initialBoard: AttendanceReviewBoard;
}

type DecisionResult = "PRESENT" | "ABSENT" | "NEEDS_REVIEW";

type StatusFilter = "all" | "review" | "absent" | "present";

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "review", label: "Needs review" },
  { key: "absent", label: "Absent" },
  { key: "present", label: "Present" },
];

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

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function reasonText(student: AttendanceReviewStudent): string {
  const reason: AttendanceReviewReason = student.reason;
  switch (reason) {
    case "low_confidence":
      return "Matched a face, but below the confidence required to mark present.";
    case "ambiguous_match":
      return "The best match was too close to another enrolled student to separate confidently.";
    case "duplicate_in_capture":
      return "Two different faces in the same photo both matched this student, so the match is not trustworthy on its own.";
    case "no_match":
      return "Compared against every captured face and matched none of them. That is not evidence of absence — they may have been hidden, turned away, or out of frame.";
    case "no_face_detected":
      return "No face was detected in any capture, so nobody could be compared. This is about the photograph, not the student.";
    case "low_quality":
      return "The captures were too poor to compare against. Retaking may resolve it.";
    case "recognition_error":
      return "Recognition failed for this session. Decide each student by calling the roll.";
    case "no_face_template":
      return "No enrolled face data — this student could not be compared at all, so this is not evidence of absence.";
    case "incompatible_face_template":
      return "Enrolled face data was captured with a different model version and could not be compared. Not evidence of absence.";
    case "recognition_unavailable":
      return "Recognition did not run for this session. Call the roll and decide each student.";
    case "manually_corrected":
      return "Set by a faculty member.";
    default:
      return "";
  }
}

/** Confidence as a short, honest label. Null means "never compared" — which
 * must not render as 0%, since that would read as a confident non-match. */
function confidenceLabel(value: number | null): string {
  if (value === null) return "not compared";
  return `${Math.round(value * 100)}% match`;
}

function confidenceToneClasses(value: number | null, presentMin: number | null): string {
  if (value === null) return "bg-neutral-100 text-neutral-600";
  if (presentMin !== null && value >= presentMin) return "bg-emerald-50 text-emerald-700";
  return "bg-amber-50 text-amber-800";
}

function Avatar({ student }: { student: AttendanceReviewStudent }) {
  // `photoUrl` is always null in this build — Student carries no photo
  // column — so the monogram is the real rendering path, not a fallback.
  if (student.photoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={student.photoUrl}
        alt=""
        className="h-9 w-9 shrink-0 rounded-full object-cover"
      />
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

function Identity({ student }: { student: AttendanceReviewStudent }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar student={student} />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-neutral-900">
          {student.firstName} {student.lastName}
        </p>
        <p className="truncate text-xs text-neutral-500">{student.studentCode}</p>
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
 * away the tree and rebuilt it on every finalized register. The bug only
 * appears once a session is finalized, which is why it survived until
 * finalization became routine.
 *
 * So the server emits the ISO instant — stable, machine-readable, and what
 * `<time dateTime>` wants anyway — and the locale formatting happens after
 * mount, where the browser's own locale is the right one to use.
 */
function LocalTime({ iso }: { iso: string }) {
  // `useSyncExternalStore` is the tool for a value that lives outside React and
  // whose server snapshot is *allowed* to differ from the client one — exactly
  // this case, and the same pattern the capture wizard uses for
  // `navigator.onLine`. Subscribing is a no-op because a browser's locale does
  // not change while the page is open.
  const onClient = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  return <time dateTime={iso}>{onClient ? new Date(iso).toLocaleString() : iso}</time>;
}

/**
 * `note` exists because of one specific way these tiles could lie. The Present
 * tile counts decisions, and a recognition suggestion is not one — so while
 * suggestions are pending the tile reads 0 above a Present column holding
 * three people. Both numbers are correct, and together they look like a bug.
 * The note says which is which.
 */
function CountCard({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: number;
  tone: "neutral" | "present" | "absent" | "review";
  note?: string;
}) {
  const toneClass =
    tone === "present"
      ? "text-emerald-700"
      : tone === "review"
        ? "text-amber-700"
        : "text-neutral-900";
  return (
    <div className="rounded-md border border-neutral-200 px-4 py-3">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className={`text-2xl font-semibold tabular-nums ${toneClass}`} aria-live="polite">
        {value}
      </dd>
      {note ? (
        <p className="mt-0.5 text-xs font-medium text-amber-700" aria-live="polite">
          {note}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ReviewBoard({ initialBoard }: Props) {
  const router = useRouter();
  const [board, setBoard] = useState(initialBoard);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const sessionId = board.session.id;
  const isFinalized = board.session.processingStatus === "FINALIZED";
  const presentMin = board.session.recognition?.presentMin ?? null;

  // -------------------------------------------------------------------------
  // Realtime. One SSE connection per open board; each event carries the
  // changed record and the authoritative counts, so a second teacher's
  // correction lands here without anybody refetching the page.
  // -------------------------------------------------------------------------
  const refresh = useCallback(async () => {
    try {
      setBoard(await getAttendanceReviewBoardAction({ sessionId }));
    } catch {
      // A failed background refresh must not clobber a usable screen. The
      // next event (or the user's next action) will reconcile.
    }
  }, [sessionId]);

  useEffect(() => {
    const source = new EventSource(`/api/realtime/attendance/${sessionId}`);
    source.onmessage = (message) => {
      let event: AttendanceRealtimeEvent;
      try {
        event = JSON.parse(message.data) as AttendanceRealtimeEvent;
      } catch {
        return;
      }
      if (event.type === "attendance-record-updated") {
        // Apply the counts immediately, then reconcile the lists. Counts are
        // what the room is watching; list membership can lag by one tick.
        setBoard((current) => ({ ...current, counts: event.counts }));
        void refresh();
      } else if (event.type === "attendance-session-finalized") {
        setLiveMessage("This attendance session was finalized.");
        void refresh();
      }
    };
    return () => source.close();
  }, [refresh, sessionId]);

  // -------------------------------------------------------------------------
  // Corrections
  // -------------------------------------------------------------------------
  const decide = useCallback(
    async (student: AttendanceReviewStudent, newResult: DecisionResult) => {
      setError(null);
      setPending((p) => ({ ...p, [student.attendanceRecordId]: true }));

      const previous = board;
      // Optimistic move: the student leaves their current list, joins the
      // new one, and the counters update in the same render. "Update
      // counters instantly" is the requirement; this is it.
      setBoard((current) => moveStudent(current, student.attendanceRecordId, newResult));

      try {
        const result = await submitReviewDecisionAction({
          attendanceRecordId: student.attendanceRecordId,
          newResult,
        });
        // Replace the optimistic counts with the server's.
        setBoard((current) => ({ ...current, counts: result.counts }));
        setLiveMessage(
          `${student.firstName} ${student.lastName} marked ${newResult.toLowerCase().replace("_", " ")}.`,
        );
        void refresh();
      } catch (e) {
        // Snap back — a correction the server refused must not appear to
        // have happened.
        setBoard(previous);
        setError(
          e instanceof Error
            ? `Could not update ${student.firstName} ${student.lastName}: ${e.message}`
            : "Could not update that student.",
        );
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[student.attendanceRecordId];
          return next;
        });
      }
    },
    [board, refresh],
  );

  const confirm = useCallback(async () => {
    setError(null);
    setConfirming(true);
    try {
      await confirmAttendanceAction({ sessionId });
      setConfirmOpen(false);
      await refresh();
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      setError(
        message.startsWith("unresolved_review_states")
          ? "Some students are still awaiting review. Resolve each one as present or absent before confirming."
          : message
            ? `Could not confirm attendance: ${message}`
            : "Could not confirm attendance.",
      );
      void refresh();
    } finally {
      setConfirming(false);
    }
  }, [refresh, router, sessionId]);

  // -------------------------------------------------------------------------
  // Search and filter.
  //
  // These change what is *displayed*, never what is counted. The cards above
  // stay the register's real tally: a teacher who has typed "sha" must not
  // read "Present 2" and take it for the state of the class. Section headers
  // say "2 of 43" while a search is active, for the same reason.
  //
  // Finalization is likewise unaffected — a filter cannot hide an unresolved
  // student into being confirmed, because `canFinalize` comes from the server.
  // -------------------------------------------------------------------------
  const needle = query.trim().toLowerCase();
  const filtering = needle.length > 0;
  const shownNeedsReview = useMemo(
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
  const matchCount = shownNeedsReview.length + shownAbsent.length + shownPresent.length;
  const showSection = (key: Exclude<StatusFilter, "all">) =>
    statusFilter === "all" || statusFilter === key;

  // Carried on the Present tile, which counts decisions rather than rows.
  const suggestionNote =
    board.awaitingConfirmation > 0
      ? `+${board.awaitingConfirmation} suggested, not yet confirmed`
      : undefined;
  const canPressConfirm =
    board.actorCanFinalize && board.canFinalize && !confirming && !isFinalized;

  const provenance = useMemo(() => {
    const s = board.session;
    const bits: string[] = [];
    if (s.generationSource === "manual") {
      bits.push("Built by manual roll call — recognition did not contribute");
    } else if (s.recognition) {
      bits.push(`${s.recognition.modelName} ${s.recognition.modelVersion}`);
      bits.push(
        `${s.recognition.scoredFacesTotal}/${s.recognition.detectedFacesTotal} faces scored against ${s.recognition.candidatePoolSize} students`,
      );
    }
    if (s.captureImages.length > 0) {
      bits.push(
        `${s.captureImages.length} photo${s.captureImages.length === 1 ? "" : "s"} captured`,
      );
    }
    return bits.join(" · ");
  }, [board.session]);

  return (
    <div className="flex flex-col gap-5">
      <p aria-live="polite" className="sr-only">
        {liveMessage}
      </p>

      {board.session.recognition && !board.session.recognition.productionEligible && (
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          The recognition model that produced these suggestions is{" "}
          <strong>not cleared for production use</strong>. Treat every row below as
          unverified and confirm each student yourself.
        </div>
      )}

      {isFinalized && (
        <div className="rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-xs text-neutral-700">
          <strong>Attendance finalized</strong>
          {board.session.finalizedByName ? ` by ${board.session.finalizedByName}` : ""}
          {board.session.finalizedAt ? (
            <>
              {" on "}
              <LocalTime iso={board.session.finalizedAt} />
            </>
          ) : null}
          . Students can now see their result.
          {board.actorCanOverrideFinalized
            ? " You may still correct a record; every change is recorded as an authorized override."
            : " Corrections now require an administrator."}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <CountCard label="Total students" value={board.counts.total} tone="neutral" />
        <CountCard
          label="Present"
          value={board.counts.present}
          tone="present"
          note={suggestionNote}
        />
        <CountCard label="Absent" value={board.counts.absent} tone="absent" />
        <CountCard label="Needs review" value={board.awaitingDecision} tone="review" />
      </dl>

      {provenance && <p className="text-xs text-neutral-500">{provenance}</p>}

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {/* Search and status filter. Stacks on phones; one row from `sm`. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative sm:max-w-xs sm:flex-1">
          <label htmlFor="student-search" className="sr-only">
            Search students by name or roll number
          </label>
          <input
            id="student-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or roll number"
            autoComplete="off"
            className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none"
          />
        </div>
        <div
          role="group"
          aria-label="Filter by attendance status"
          className="flex gap-1 overflow-x-auto"
        >
          {STATUS_FILTERS.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={statusFilter === option.key}
              onClick={() => setStatusFilter(option.key)}
              className={`shrink-0 rounded-md border px-2.5 py-1.5 text-xs font-medium whitespace-nowrap ${
                statusFilter === option.key
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-neutral-300 text-neutral-700 hover:bg-neutral-50"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {filtering && (
        <p aria-live="polite" className="text-xs text-neutral-500">
          {matchCount === 0
            ? `No student matches “${query.trim()}”.`
            : `${matchCount} of ${board.counts.total} students match “${query.trim()}”. Counts above are for the whole register.`}
        </p>
      )}

      {/* Needs Review first: it is the list that blocks finalization. */}
      {showSection("review") && (
      <Section
        title="Needs review"
        count={board.needsReview.length}
        shown={shownNeedsReview.length}
        filtering={filtering}
        emptyText="Nothing left to review."
        tone="review"
      >
        {shownNeedsReview.map((student) => (
          <li
            key={student.attendanceRecordId}
            className="flex flex-col gap-2 border-b border-neutral-100 px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <Identity student={student} />
              <p className="text-xs text-neutral-600">{reasonText(student)}</p>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span
                  className={`rounded-full px-2 py-0.5 font-medium ${confidenceToneClasses(student.aiConfidence, presentMin)}`}
                >
                  {confidenceLabel(student.aiConfidence)}
                </span>
                {student.bestFaceId && (
                  <span className="text-neutral-500">
                    best candidate from photo {student.bestFaceId.split(":")[0]}
                  </span>
                )}
                {!student.wasComparable && (
                  <span className="text-neutral-500">never compared</span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-neutral-500">Verify:</span>
              <Button
                onClick={() => decide(student, "PRESENT")}
                disabled={pending[student.attendanceRecordId]}
                className="!py-1 !text-xs"
              >
                Present
              </Button>
              <Button
                variant="secondary"
                onClick={() => decide(student, "ABSENT")}
                disabled={pending[student.attendanceRecordId]}
                className="!py-1 !text-xs"
              >
                Absent
              </Button>
            </div>
          </li>
        ))}
      </Section>
      )}

      {showSection("absent") && (
      <Section
        title="Absent"
        count={board.absent.length}
        shown={shownAbsent.length}
        filtering={filtering}
        emptyText="Nobody is marked absent."
        tone="neutral"
      >
        {shownAbsent.map((student) => (
          <li
            key={student.attendanceRecordId}
            className="flex items-center justify-between gap-3 border-b border-neutral-100 px-4 py-2.5 last:border-b-0"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <Identity student={student} />
              <p className="pl-12 text-xs text-neutral-500">
                {student.isManuallyCorrected ? "Marked absent by faculty" : reasonText(student)}
              </p>
            </div>
            <Button
              variant="secondary"
              onClick={() => decide(student, "PRESENT")}
              disabled={pending[student.attendanceRecordId]}
              className="!py-1 !text-xs"
            >
              Mark present
            </Button>
          </li>
        ))}
      </Section>
      )}

      {showSection("present") && (
      <Section
        title={
          board.awaitingConfirmation > 0
            ? `Present · ${board.awaitingConfirmation} awaiting confirmation`
            : "Present"
        }
        count={board.present.length}
        shown={shownPresent.length}
        filtering={filtering}
        emptyText="Nobody is marked present yet."
        tone="present"
      >
        {shownPresent.map((student) => {
          // A suggestion is not a result. Both live in this column because
          // that is where a reviewer looks for them, but a row nobody has
          // confirmed says so plainly and offers the confirm action.
          const suggested = student.finalResult !== "PRESENT";
          return (
            <li
              key={student.attendanceRecordId}
              className={`flex flex-col gap-2 border-b border-neutral-100 px-4 py-2.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between ${
                suggested ? "bg-amber-50/40" : ""
              }`}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <Identity student={student} />
                <p className="pl-12 text-xs text-neutral-500">
                  {suggested
                    ? "Suggested by recognition — not yet confirmed."
                    : student.isManuallyCorrected
                      ? "Confirmed by faculty."
                      : "Confirmed."}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${confidenceToneClasses(student.aiConfidence, presentMin)}`}
                  title={
                    student.isManuallyCorrected
                      ? `Set by faculty. The system's own result was ${student.aiResult.toLowerCase().replace("_", " ")}.`
                      : "Proposed by recognition"
                  }
                >
                  {student.isManuallyCorrected
                    ? "marked by faculty"
                    : confidenceLabel(student.aiConfidence)}
                </span>
                {suggested && (
                  <Button
                    onClick={() => decide(student, "PRESENT")}
                    disabled={pending[student.attendanceRecordId]}
                    className="!py-1 !text-xs"
                  >
                    Confirm
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={() => decide(student, "ABSENT")}
                  disabled={pending[student.attendanceRecordId]}
                  className="!py-1 !text-xs"
                >
                  Mark absent
                </Button>
              </div>
            </li>
          );
        })}
      </Section>
      )}

      {/* Finalization */}
      {!isFinalized && (
        <section className="flex flex-col gap-3 rounded-md border border-neutral-200 p-4">
          <h2 className="text-sm font-semibold text-neutral-900">Confirm attendance</h2>
          {!confirmOpen ? (
            <>
              <p className="text-xs text-neutral-600">
                Confirming closes this register. Students will be able to see their
                own result, and further changes become authorized corrections.
              </p>
              {board.awaitingConfirmation > 0 && (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <strong>
                    {board.awaitingConfirmation} student
                    {board.awaitingConfirmation === 1 ? " is" : "s are"} marked present by
                    recognition and not yet confirmed by you.
                  </strong>{" "}
                  Confirming accepts {board.awaitingConfirmation === 1 ? "that" : "those"}{" "}
                  suggestion{board.awaitingConfirmation === 1 ? "" : "s"} as your decision, and
                  each one is recorded against your name. Check them above first if you have not.
                </p>
              )}
              {board.finalizeBlockedReason && (
                <p className="text-xs text-amber-800">{board.finalizeBlockedReason}</p>
              )}
              {!board.actorCanFinalize && (
                <p className="text-xs text-amber-800">
                  You do not have permission to finalize attendance. Ask a class
                  teacher or administrator to confirm this register.
                </p>
              )}
              <div>
                <Button onClick={() => setConfirmOpen(true)} disabled={!canPressConfirm}>
                  Confirm attendance
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-neutral-600">
                You are about to finalize attendance for{" "}
                <strong>{board.counts.total}</strong> students
                {board.awaitingConfirmation > 0 ? (
                  <>
                    , accepting <strong>{board.awaitingConfirmation}</strong> recognition
                    suggestion{board.awaitingConfirmation === 1 ? "" : "s"} as your own decision
                  </>
                ) : null}
                :
              </p>
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <CountCard label="Total students" value={board.counts.total} tone="neutral" />
                <CountCard
                  label="Present"
                  value={board.counts.present}
                  tone="present"
                  note={suggestionNote}
                />
                <CountCard label="Absent" value={board.counts.absent} tone="absent" />
                <CountCard label="Needs review" value={board.awaitingDecision} tone="review" />
              </dl>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={confirm} disabled={!canPressConfirm}>
                  {confirming ? "Confirming…" : "Yes, finalize attendance"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setConfirmOpen(false)}
                  disabled={confirming}
                >
                  Go back
                </Button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  shown,
  filtering = false,
  emptyText,
  tone,
  children,
}: {
  title: string;
  /** How many students are really in this list. */
  count: number;
  /** How many survive the current search. Equals `count` when not searching. */
  shown: number;
  filtering?: boolean;
  emptyText: string;
  tone: "neutral" | "present" | "review";
  children: React.ReactNode;
}) {
  const headerTone =
    tone === "present"
      ? "text-emerald-700"
      : tone === "review"
        ? "text-amber-700"
        : "text-neutral-700";
  return (
    <section className="overflow-hidden rounded-md border border-neutral-200">
      <header className="flex items-baseline justify-between border-b border-neutral-200 bg-neutral-50 px-4 py-2">
        <h2 className={`text-sm font-semibold ${headerTone}`}>{title}</h2>
        {/* "2 of 43" while searching: the header must never be mistaken for
            the size of the list it is heading. */}
        <span className="text-xs tabular-nums text-neutral-500">
          {filtering && shown !== count ? `${shown} of ${count}` : count}
        </span>
      </header>
      {shown === 0 ? (
        <p className="px-4 py-3 text-xs text-neutral-500">
          {count > 0 ? "No student here matches your search." : emptyText}
        </p>
      ) : (
        <ul>{children}</ul>
      )}
    </section>
  );
}

/**
 * Optimistic list surgery. Moves one record between the three lists and
 * recomputes the counters from the lists themselves, so the displayed tally
 * can never disagree with the displayed rows.
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

  // The same grouping rule the server applies: an unconfirmed suggestion
  // belongs in Present, not in Needs Review. Splitting on `finalResult` alone
  // would optimistically fling every *other* suggested row into Needs Review
  // for the moment between the click and the refresh.
  const unresolved = (s: AttendanceReviewStudent) =>
    s.finalResult === "NEEDS_REVIEW" || s.finalResult === "NOT_EVALUATED";
  const suggestedPresent = (s: AttendanceReviewStudent) =>
    unresolved(s) && s.aiSuggestion === "PRESENT" && !s.isManuallyCorrected;

  const present = [...rest.filter((s) => s.finalResult === "PRESENT" || suggestedPresent(s))];
  const absent = [...rest.filter((s) => s.finalResult === "ABSENT")];
  const needsReview = [...rest.filter((s) => unresolved(s) && !suggestedPresent(s))];
  if (newResult === "PRESENT") present.push(moved);
  else if (newResult === "ABSENT") absent.push(moved);
  else needsReview.push(moved);

  present.sort(byName);
  absent.sort(byName);
  needsReview.sort(byName);

  return {
    ...board,
    present,
    absent,
    needsReview,
    counts: {
      total: present.length + absent.length + needsReview.length,
      present: present.length,
      absent: absent.length,
      needsReview: needsReview.length,
      notEvaluated: 0,
    },
  };
}

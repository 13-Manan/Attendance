"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getOwnAttendanceAction } from "@/modules/attendance-review/actions";
import type {
  StudentAttendanceEntry,
  StudentAttendanceView,
} from "@/modules/attendance-review/types";
import type { StudentAttendanceUpdatedEvent } from "@/modules/realtime/types";
import { useLiveStream } from "@/modules/realtime/use-live-stream";

/**
 * The student-facing half of the realtime story.
 *
 * Subscribes to the student's own SSE channel and refetches only this
 * component's data when their own result changes — the page is not reloaded
 * and no other student's information ever crosses the wire. The event itself
 * is used as a signal, not as the source of truth: the refetch goes back
 * through the same authorized action that rendered the page.
 */

interface Props {
  initialView: StudentAttendanceView;
}

/**
 * A date in the reader's own locale, without a hydration mismatch.
 *
 * `toLocaleDateString()` asks the runtime for its locale and timezone, and the
 * server's are not the student's — so this rendered one string on the server
 * and another in the browser, React threw the tree away and logged error #418
 * on every visit to this page. The review board hit the same thing and solved
 * it the same way (`LocalTime` there); this is that fix, for the portal.
 *
 * The ISO instant is what the server emits, which is also what `<time>` wants.
 */
function LocalDate({ iso }: { iso: string }) {
  const onClient = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const date = new Date(iso);
  return (
    <time dateTime={iso}>
      {onClient
        ? date.toLocaleDateString(undefined, {
            weekday: "short",
            year: "numeric",
            month: "short",
            day: "numeric",
          })
        : iso.slice(0, 10)}
    </time>
  );
}

function resultBadge(result: StudentAttendanceEntry["finalResult"]) {
  switch (result) {
    case "PRESENT":
      return { label: "Present", classes: "bg-emerald-50 text-emerald-700 border-emerald-200" };
    case "ABSENT":
      return { label: "Absent", classes: "bg-red-50 text-red-700 border-red-200" };
    case "NEEDS_REVIEW":
      return { label: "Under review", classes: "bg-amber-50 text-amber-800 border-amber-200" };
    default:
      return { label: "Not recorded", classes: "bg-neutral-50 text-neutral-600 border-neutral-200" };
  }
}

export function StudentAttendanceClient({ initialView }: Props) {
  const [view, setView] = useState(initialView);
  const [justUpdated, setJustUpdated] = useState(false);

  const studentId = view.studentId;

  /**
   * Monotonic counter guarding against an older response landing last.
   *
   * Two refetches can be in flight at once — a reconnect reconciliation and an
   * event that arrived while it was running. They are the same query, so the
   * later request holds the newer truth; without this the earlier response can
   * resolve second and put a stale register back on screen.
   */
  const latestFetch = useRef(0);

  const refetch = useCallback(async () => {
    const ticket = ++latestFetch.current;
    try {
      const fresh = await getOwnAttendanceAction();
      // A newer refetch started while this one was in flight; its answer wins.
      if (ticket !== latestFetch.current) return;
      if (fresh) {
        setView(fresh);
        setJustUpdated(true);
      }
    } catch {
      // Keep showing the last good data rather than blanking the page on a
      // transient failure.
    }
  }, []);

  const handleEvent = useCallback(
    (event: StudentAttendanceUpdatedEvent) => {
      // Both finalization and a post-finalization correction reach here;
      // either way the student's visible record may have changed. The event is
      // a signal — the refetch goes back through the authorized action.
      if (event.type === "student-attendance-updated") void refetch();
    },
    [refetch],
  );

  const { state: connection } = useLiveStream<StudentAttendanceUpdatedEvent>({
    url: `/api/realtime/student/${studentId}`,
    onEvent: handleEvent,
    // A reconnect may have skipped an update, so re-read rather than assume.
    onReconnect: refetch,
  });

  useEffect(() => {
    if (!justUpdated) return;
    const t = setTimeout(() => setJustUpdated(false), 4000);
    return () => clearTimeout(t);
  }, [justUpdated]);

  return (
    <div className="flex flex-col gap-4">
      <p aria-live="polite" className="sr-only">
        {justUpdated ? "Your attendance record was updated." : ""}
      </p>

      {/*
        Shown only once a live connection has been lost — never on first load,
        and never per retry attempt, so the announcement fires on the change of
        state rather than on every attempt. Carries its own words rather than a
        colour, so it reads the same to somebody who cannot see the amber.
      */}
      {connection === "reconnecting" && (
        <p
          role="status"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          Reconnecting for live updates. Your attendance record is safe — this
          page will catch up on its own.
        </p>
      )}
      {connection === "unauthorized" && (
        <p
          role="status"
          className="rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-xs text-neutral-700"
        >
          Live updates have stopped. Reload the page to sign in again.
        </p>
      )}

      {justUpdated && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          Your attendance record was just updated.
        </div>
      )}

      <dl className="grid grid-cols-3 gap-3">
        <div className="rounded-md border border-neutral-200 px-4 py-3">
          <dt className="text-xs text-neutral-500">Classes shown</dt>
          <dd className="text-2xl font-semibold tabular-nums text-neutral-900">
            {view.entries.length}
          </dd>
        </div>
        <div className="rounded-md border border-neutral-200 px-4 py-3">
          <dt className="text-xs text-neutral-500">Present</dt>
          <dd className="text-2xl font-semibold tabular-nums text-emerald-700">
            {view.presentCount}
          </dd>
        </div>
        <div className="rounded-md border border-neutral-200 px-4 py-3">
          <dt className="text-xs text-neutral-500">Absent</dt>
          <dd className="text-2xl font-semibold tabular-nums text-neutral-900">
            {view.absentCount}
          </dd>
        </div>
      </dl>

      {view.entries.length === 0 ? (
        <p className="rounded-md border border-neutral-200 px-4 py-6 text-center text-sm text-neutral-500">
          No confirmed attendance yet. A class appears here once your teacher
          confirms it.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-md border border-neutral-200">
          {view.entries.map((entry) => {
            const badge = resultBadge(entry.finalResult);
            return (
              <li key={entry.attendanceRecordId} className="border-b border-neutral-100 last:border-b-0">
                {/* The whole row is the target — a tap area that works on a
                    phone, not a small "details" link beside the badge. */}
                <Link
                  href={`/portal/attendance/${entry.attendanceRecordId}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-neutral-50"
                >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-neutral-900">
                    {entry.subjectName ?? entry.cohortName}
                    {entry.subjectCode ? (
                      <span className="ml-2 text-xs font-normal text-neutral-500">
                        {entry.subjectCode}
                      </span>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-neutral-500">
                    <LocalDate iso={entry.sessionDate} />
                    {entry.subjectName ? ` · ${entry.cohortName}` : ""}
                    {entry.isManuallyCorrected ? " · confirmed by your teacher" : ""}
                  </p>
                </div>
                  <span
                    className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge.classes}`}
                  >
                    {badge.label}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-neutral-500">
        Only classes your teacher has confirmed appear here. If something looks
        wrong, contact your teacher — they can correct a record.
      </p>
    </div>
  );
}

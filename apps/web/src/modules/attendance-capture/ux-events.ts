/**
 * The teacher's path through taking attendance, as structured log lines.
 *
 * The same infrastructure every other structured line here uses: one JSON
 * object per line on stdout, keyed by `log`, which the container platform
 * ships to Log Analytics. No analytics SDK and no client beacon — each event
 * is written by the Server Action the step already calls, after it succeeded:
 *
 *   attendance_start      today's register opened or resumed (Start)
 *   capture               a photo's face check came back
 *   recognition_complete  the photos were matched and the register written
 *   attendance_manual     the register was built by hand instead
 *   review_open           the review board was opened
 *   attendance_finalize   the teacher finished the register
 *
 * What a line may carry is a closed list, enforced here rather than trusted to
 * callers: opaque ids, states and counts. Never an image, an embedding, a
 * face's position, a student's name or id, or a credential.
 */

export type AttendanceUxEvent =
  | "attendance_start"
  | "capture"
  | "recognition_complete"
  | "attendance_manual"
  | "review_open"
  | "attendance_finalize";

export interface AttendanceUxFields {
  sessionId: string;
  cohortId?: string;
  mode?: "DAILY" | "SUBJECT_WISE";
  /** Start found today's register already open. */
  resumed?: boolean;
  status?: string;
  sequenceNumber?: number;
  faces?: number;
  photos?: number;
  /** Photos added to a register already in review. */
  merged?: boolean;
  present?: number;
  needsReview?: number;
  absent?: number;
  total?: number;
}

const ALLOWED: ReadonlyArray<keyof AttendanceUxFields> = [
  "sessionId",
  "cohortId",
  "mode",
  "resumed",
  "status",
  "sequenceNumber",
  "faces",
  "photos",
  "merged",
  "present",
  "needsReview",
  "absent",
  "total",
];

/** The line, built from the allowed fields only; anything else a caller passes is dropped. */
export function attendanceUxLine(event: AttendanceUxEvent, fields: AttendanceUxFields): string {
  const line: Record<string, string | number | boolean> = { log: "attendance.ux", event };
  const given = fields as unknown as Record<string, unknown>;
  for (const key of ALLOWED) {
    const value = given[key];
    if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      line[key] = value;
    }
  }
  return JSON.stringify(line);
}

/** Never lets observability break the flow it observes. */
export function logAttendanceUx(event: AttendanceUxEvent, fields: AttendanceUxFields): void {
  try {
    console.info(attendanceUxLine(event, fields));
  } catch {
    // A log line is not worth a failed attendance step.
  }
}

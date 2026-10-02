import { ForbiddenError } from "@/modules/authorization/types";
import { studentResultLabel } from "@/modules/recognition-engine/wording";
import type { AttendanceReviewBoard, AttendanceReviewReason, AttendanceReviewStudent } from "./types";

/**
 * The review board's decisions, as plain functions: what the summary says,
 * what each student needing attention is told in a line, when the register can
 * be finished, and how a failure is explained.
 *
 * Nothing here changes a result. Who is present, who needs a person and when
 * a register may be finalized are the service's; this file only words them.
 */

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

export interface ReviewSummary {
  total: number;
  /** Present — recognised or marked by a person. */
  present: number;
  /** Not confidently present: each one waits for the teacher. */
  attention: number;
  absent: number;
  /**
   * Present rows still stored as suggestions: registers written before
   * recognised students were recorded present. Finishing records them.
   */
  legacySuggestions: number;
  /** Whether "Finish attendance" can be pressed now. */
  canFinish: boolean;
  /** Why not, in a teacher's words; null when it can, or once finished. */
  finishBlockedReason: string | null;
}

function students(n: number): string {
  return `${n} student${n === 1 ? "" : "s"}`;
}

/** "Review 6 students" — the one button that leads to the students who need the teacher. */
export function reviewButtonLabel(attention: number): string {
  return `Review ${students(attention)}`;
}

/** "need attention" after a count of 6, "needs attention" after 1. */
export function needAttentionWords(attention: number): string {
  return attention === 1 ? "needs attention" : "need attention";
}

export function reviewSummaryOf(board: AttendanceReviewBoard): ReviewSummary {
  const present = board.present.length;
  const attention = board.needsReview.length;
  const absent = board.absent.length;
  const finished = board.session.processingStatus === "FINALIZED";
  let finishBlockedReason: string | null = null;
  if (!finished) {
    if (!board.actorCanFinalize) {
      finishBlockedReason = "Only a class teacher or administrator can finish this register.";
    } else if (attention > 0) {
      finishBlockedReason = `${students(attention)} still ${attention === 1 ? "needs" : "need"} you.`;
    } else if (!board.canFinalize) {
      finishBlockedReason = board.finalizeBlockedReason ?? "This register can't be finished yet.";
    }
  }
  return {
    total: present + attention + absent,
    present,
    attention,
    absent,
    legacySuggestions: board.awaitingConfirmation,
    canFinish: !finished && board.actorCanFinalize && board.canFinalize && attention === 0,
    finishBlockedReason,
  };
}

/**
 * "Recognised", "Marked by a teacher" — who decided, under a name. Short
 * enough for one line on a small phone; the list it sits in says present or
 * absent.
 */
export function presentProvenance(student: AttendanceReviewStudent): string {
  if (student.isManuallyCorrected) return "Marked by a teacher";
  if (student.finalResult !== "PRESENT") return "Recognised — recorded when you finish";
  return "Recognised";
}

export function absentProvenance(student: AttendanceReviewStudent): string {
  return student.isManuallyCorrected ? "Marked by a teacher" : "Absent";
}

/**
 * Why a student needs the teacher, in a few words — the "Reason:" line a
 * teacher scans. The full explanation is behind Review (`reasonDetail`).
 *
 * Not detected is not absent: nothing here says a student was away, only what
 * the camera could and could not establish.
 */
export function shortReason(reason: AttendanceReviewReason): string {
  switch (reason) {
    case "no_match":
      return "Not detected in the photo";
    case "low_confidence":
      return "Not sure it's them";
    case "ambiguous_match":
      return "Looks like another student";
    case "duplicate_in_capture":
      return "Matched twice in one photo";
    case "face_too_small":
      return "Too far away to recognise";
    case "low_quality":
      return "Photo too unclear";
    case "no_face_detected":
      return "No faces found in the photo";
    case "no_face_template":
      return "No face photo on file";
    case "incompatible_face_template":
      return "Face photo needs updating";
    case "recognition_error":
    case "recognition_unavailable":
    case "identification_unavailable":
      return "Face matching wasn't available";
    case "manually_corrected":
      return "Changed by a teacher";
    default:
      return "Needs a decision";
  }
}

/** The full explanation behind Review: what the camera established, and what it did not. */
export function reasonDetail(reason: AttendanceReviewReason): string {
  switch (reason) {
    case "low_confidence":
      return "A face matched, but not closely enough to be sure it was this student.";
    case "ambiguous_match":
      return "The best match was too close to another student to tell them apart.";
    case "duplicate_in_capture":
      return "Two different faces in the same photo both looked like this student, so neither can be trusted on its own.";
    case "no_match":
      return "Every face in the photo was compared and none was this student. That is not proof of absence — they may have been hidden, turned away or out of frame.";
    case "no_face_detected":
      return "No face was found in any photo, so nobody could be compared. This is about the photo, not the student.";
    case "low_quality":
      return "The photos were too unclear to compare. Another photo may resolve it.";
    case "face_too_small":
      return "A face that may be this student's was too small in the photo to recognise. A closer photo usually resolves it.";
    case "recognition_error":
      return "Face matching failed for this register. Decide each student yourself.";
    case "no_face_template":
      return "This student has no face photo on file, so they could not be compared. That is not proof of absence.";
    case "incompatible_face_template":
      return "This student's face photo needs to be taken again before they can be recognised. That is not proof of absence.";
    case "recognition_unavailable":
      return "Face matching did not run for this register. Decide each student yourself.";
    case "identification_unavailable":
      return "Faces were counted, but matching was not available, so nobody was compared. Decide this student yourself.";
    case "manually_corrected":
      return "Set by a teacher.";
    default:
      return "Look for this student in the class, then mark them present or absent.";
  }
}

/**
 * What recognition found for one student, line by line, under Review: the
 * finding ("Needs review — 58%"), which photo held the closest face, and
 * whether they were ever compared at all.
 */
export function evidenceOf(student: AttendanceReviewStudent): string[] {
  const lines: string[] = [];
  const finding = studentResultLabel({
    suggestion: student.aiSuggestion,
    aiResult: student.aiResult,
    aiConfidence: student.aiConfidence,
    reason: student.reason,
  });
  if (finding) lines.push(`Recognition: ${finding}`);
  if (student.bestFaceId) lines.push(`Closest face: photo ${student.bestFaceId.split(":")[0]}`);
  if (!student.wasComparable) lines.push("Never compared with the photos");
  return lines;
}

// ---------------------------------------------------------------------------
// Errors, as codes the server can hand back safely
// ---------------------------------------------------------------------------

/**
 * Why a decision or finishing failed, as a code. A thrown Server Action
 * message does not survive a production build, so the board's actions read it
 * on the server and return one of these instead (see `flow-actions.ts`).
 */
export type ReviewFlowErrorCode =
  | "not_allowed"
  | "register_finished"
  | "register_closed"
  | "register_changed"
  | "window_closed"
  | "reason_required"
  | "still_unresolved"
  | "not_found"
  | "unknown";

export type ReviewFlowResult<T> = { ok: true; value: T } | { ok: false; code: ReviewFlowErrorCode };

/** Server side: the tagged error the services throw, as a code. */
export function reviewFlowErrorCode(error: unknown): ReviewFlowErrorCode {
  if (error instanceof ForbiddenError) {
    if (error.reason.startsWith("correction_window_closed")) return "window_closed";
    if (error.reason === "attendance_finalized") return "register_finished";
    return "not_allowed";
  }
  const raw = error instanceof Error ? error.message : "";
  if (raw === "correction_reason_required") return "reason_required";
  if (raw.startsWith("unresolved_review_states")) return "still_unresolved";
  if (raw === "session_status_conflict") return "register_changed";
  if (raw.startsWith("invalid_transition:FINALIZED") || raw.startsWith("session_locked:FINALIZED")) {
    return "register_finished";
  }
  if (raw === "session_cancelled" || raw.startsWith("invalid_transition:") || raw.startsWith("session_locked:")) {
    return "register_closed";
  }
  if (raw === "attendance_record_not_found" || raw === "session_not_found" || raw === "no_attendance_records") {
    return "not_found";
  }
  return "unknown";
}

export function describeReviewFlowError(code: ReviewFlowErrorCode): string {
  switch (code) {
    case "not_allowed":
      return "You can't change this register. Ask the class teacher or an administrator.";
    case "register_finished":
      return "This register is already finished.";
    case "register_closed":
      return "This register was cancelled and can't be changed.";
    case "register_changed":
      return "This register was changed on another device at the same moment. It has been refreshed — try again.";
    case "window_closed":
      return "The time allowed for changes to this register has passed. Ask an administrator.";
    case "reason_required":
      return "Add a short reason for this change, then save it again.";
    case "still_unresolved":
      return "Some students still need you. Mark each one present or absent, then finish.";
    case "not_found":
      return "That student or register could not be found. Refresh the page.";
    case "unknown":
      return "Something went wrong. Try again.";
  }
}

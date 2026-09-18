import type { MatchStatus, MatchThresholds } from "@attendance/shared-types";
import type { AttendanceResult, ConfidenceThresholds } from "./types";

/**
 * The "Confidence Engine" pipeline step. `confidence` is the best cosine
 * similarity found for a student against the session's classroom images, or
 * null when no candidate embedding matched at all. This is the only place
 * that turns a raw similarity score into a Present/Absent/Needs-Review
 * decision — the result it returns is advisory (AttendanceRecord.aiResult),
 * never the final, faculty-owned decision.
 */
export function classifyRecognitionConfidence(
  confidence: number | null,
  thresholds: ConfidenceThresholds,
): AttendanceResult {
  if (confidence === null) return "ABSENT";
  if (confidence >= thresholds.presentMin) return "PRESENT";
  if (confidence >= thresholds.reviewMin) return "NEEDS_REVIEW";
  return "ABSENT";
}

/**
 * Translates the AI service's normalized match status into our attendance
 * vocabulary.
 *
 * The face service speaks MATCHED/UNCERTAIN/UNMATCHED and knows nothing
 * about attendance; this function is the only place the two vocabularies
 * meet, so swapping the model — or the whole service — cannot change what
 * PRESENT means. Note that UNCERTAIN maps to NEEDS_REVIEW, never PRESENT:
 * a low-confidence match is a question for the faculty member, not an
 * attendance mark.
 *
 * The result is still advisory (AttendanceRecord.aiResult). Only
 * `correctAttendanceRecord` can change `finalResult`.
 */
export function matchStatusToAttendanceResult(status: MatchStatus): AttendanceResult {
  switch (status) {
    case "MATCHED":
      return "PRESENT";
    case "UNCERTAIN":
      return "NEEDS_REVIEW";
    case "UNMATCHED":
      return "ABSENT";
  }
}

/**
 * Projects an institution's configured thresholds onto the AI contract's
 * threshold shape.
 *
 * Thresholds are product policy and belong to the institution, so they are
 * sent with each match request rather than being compiled into the model
 * backend. The service echoes back the values it actually applied, which is
 * what makes a stored recognition result explainable after the fact.
 */
export function toMatchThresholds(thresholds: ConfidenceThresholds): MatchThresholds {
  return {
    matchThreshold: thresholds.presentMin,
    reviewThreshold: thresholds.reviewMin,
  };
}

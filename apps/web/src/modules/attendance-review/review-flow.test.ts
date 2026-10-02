import { test } from "node:test";
import assert from "node:assert/strict";
import { ForbiddenError } from "../authorization/types.ts";
import {
  absentProvenance,
  describeReviewFlowError,
  evidenceOf,
  needAttentionWords,
  presentProvenance,
  reasonDetail,
  reviewButtonLabel,
  reviewFlowErrorCode,
  reviewSummaryOf,
  shortReason,
  type ReviewFlowErrorCode,
} from "./review-flow.ts";
import type { AttendanceReviewBoard, AttendanceReviewReason, AttendanceReviewStudent } from "./types.ts";

const JARGON = /azure|dlib|model|embedding|provider|vector|confidence|_/i;

function student(
  id: string,
  finalResult: AttendanceReviewStudent["finalResult"],
  extra: Partial<AttendanceReviewStudent> = {},
): AttendanceReviewStudent {
  return {
    studentId: id,
    attendanceRecordId: `rec-${id}`,
    studentCode: id.toUpperCase(),
    firstName: id,
    lastName: "Test",
    initials: "T",
    photoUrl: null,
    aiResult: finalResult === "PRESENT" ? "PRESENT" : "ABSENT",
    aiConfidence: null,
    finalResult,
    isManuallyCorrected: false,
    reason: finalResult === "PRESENT" ? null : "no_match",
    aiSuggestion: finalResult === "PRESENT" ? "PRESENT" : null,
    wasComparable: true,
    wasAmbiguous: false,
    bestFaceId: null,
    ...extra,
  } as AttendanceReviewStudent;
}

function board(
  counts: { present: number; attention: number; absent: number },
  extra: Partial<AttendanceReviewBoard> & { status?: string } = {},
): AttendanceReviewBoard {
  const present = Array.from({ length: counts.present }, (_, i) => student(`p${i}`, "PRESENT"));
  const needsReview = Array.from({ length: counts.attention }, (_, i) => student(`r${i}`, "NEEDS_REVIEW"));
  const absent = Array.from({ length: counts.absent }, (_, i) =>
    student(`a${i}`, "ABSENT", { isManuallyCorrected: true, reason: "manually_corrected" }),
  );
  const { status = "REVIEW", ...rest } = extra;
  return {
    session: { processingStatus: status } as AttendanceReviewBoard["session"],
    counts: {
      total: counts.present + counts.attention + counts.absent,
      present: counts.present,
      absent: counts.absent,
      needsReview: counts.attention,
      notEvaluated: 0,
    },
    present,
    absent,
    needsReview,
    canFinalize: counts.attention === 0,
    finalizeBlockedReason: counts.attention === 0 ? null : `${counts.attention} students still need review.`,
    awaitingConfirmation: 0,
    awaitingDecision: counts.attention,
    actorCanFinalize: true,
    actorCanOverrideFinalized: true,
    ...rest,
  };
}

test("34 expected, 31 recognised, 3 to review: 31 present, 3 need attention, finishing waits for the 3", () => {
  const summary = reviewSummaryOf(board({ present: 31, attention: 3, absent: 0 }));
  assert.deepEqual(
    [summary.total, summary.present, summary.attention, summary.absent],
    [34, 31, 3, 0],
  );
  assert.equal(summary.canFinish, false);
  assert.equal(summary.finishBlockedReason, "3 students still need you.");
});

test("once the 3 are decided, the register can be finished — no approval owed on the 31", () => {
  const summary = reviewSummaryOf(board({ present: 31, attention: 0, absent: 3 }));
  assert.equal(summary.canFinish, true);
  assert.equal(summary.finishBlockedReason, null);
  assert.equal(summary.legacySuggestions, 0);
});

test("finishing is the class teacher's: without the permission it says who can", () => {
  const summary = reviewSummaryOf(board({ present: 31, attention: 0, absent: 3 }, { actorCanFinalize: false }));
  assert.equal(summary.canFinish, false);
  assert.match(summary.finishBlockedReason ?? "", /class teacher or administrator/);
});

test("a finished register offers nothing to finish and says nothing is blocking", () => {
  const summary = reviewSummaryOf(board({ present: 31, attention: 0, absent: 3 }, { status: "FINALIZED", canFinalize: false }));
  assert.equal(summary.canFinish, false);
  assert.equal(summary.finishBlockedReason, null);
});

test("the server's own refusal is carried through when nothing on screen explains it", () => {
  const summary = reviewSummaryOf(
    board({ present: 0, attention: 0, absent: 0 }, { canFinalize: false, finalizeBlockedReason: "No attendance candidates have been generated for this session yet." }),
  );
  assert.equal(summary.canFinish, false);
  assert.match(summary.finishBlockedReason ?? "", /No attendance candidates/);
});

test("a register written under the suggestion rule counts its suggestions as present and says so", () => {
  const legacy = board({ present: 0, attention: 0, absent: 2 }, { awaitingConfirmation: 3 });
  legacy.present = ["s1", "s2", "s3"].map((id) => student(id, "NEEDS_REVIEW", { aiSuggestion: "PRESENT", reason: null }));
  const summary = reviewSummaryOf(legacy);
  assert.equal(summary.present, 3);
  assert.equal(summary.legacySuggestions, 3);
  assert.equal(presentProvenance(legacy.present[0]), "Recognised — recorded when you finish");
});

test("each present or absent row says who decided it", () => {
  assert.equal(presentProvenance(student("x", "PRESENT")), "Recognised");
  assert.equal(presentProvenance(student("x", "PRESENT", { isManuallyCorrected: true })), "Marked by a teacher");
  assert.equal(absentProvenance(student("x", "ABSENT", { isManuallyCorrected: true })), "Marked by a teacher");
});

test("every reason a student needs attention has a few plain words", () => {
  const reasons: AttendanceReviewReason[] = [
    "no_match",
    "low_confidence",
    "ambiguous_match",
    "duplicate_in_capture",
    "face_too_small",
    "low_quality",
    "no_face_detected",
    "no_face_template",
    "incompatible_face_template",
    "recognition_error",
    "recognition_unavailable",
    "identification_unavailable",
    "manually_corrected",
    null,
  ];
  for (const reason of reasons) {
    const words = shortReason(reason);
    assert.ok(words.length > 0 && words.length <= 32, `${reason}: "${words}"`);
    assert.doesNotMatch(words, JARGON, String(reason));
    // Not present is not absent: the line under a name never concludes that.
    assert.doesNotMatch(words, /\babsent\b/i, String(reason));
    const detail = reasonDetail(reason);
    assert.ok(detail.length > 0, `${reason}: the Review panel always explains`);
    assert.doesNotMatch(detail, JARGON, String(reason));
  }
  assert.equal(shortReason("no_match"), "Not detected in the photo");
  assert.match(reasonDetail("no_match"), /not proof of absence/);
});

test("the summary's words: 'Review 6 students', '6 need attention', and the singular", () => {
  assert.equal(reviewButtonLabel(6), "Review 6 students");
  assert.equal(reviewButtonLabel(1), "Review 1 student");
  assert.equal(needAttentionWords(6), "need attention");
  assert.equal(needAttentionWords(1), "needs attention");
});

test("Review shows what recognition found, which photo held the closest face, and whether they were compared", () => {
  const unsure = student("u", "NEEDS_REVIEW", {
    aiResult: "NEEDS_REVIEW",
    aiConfidence: 0.58,
    reason: "low_confidence",
    bestFaceId: "2:4",
  });
  assert.deepEqual(evidenceOf(unsure), ["Recognition: Needs review — 58%", "Closest face: photo 2"]);
  const neverCompared = student("n", "NEEDS_REVIEW", {
    aiResult: "NOT_EVALUATED",
    reason: "no_face_template",
    wasComparable: false,
  });
  assert.deepEqual(evidenceOf(neverCompared), ["Never compared with the photos"]);
  for (const line of [...evidenceOf(unsure), ...evidenceOf(neverCompared)]) {
    assert.doesNotMatch(line, /azure|dlib|embedding|vector|_/i);
  }
});

test("the services' refusals become codes on the server — never a raw or minified message", () => {
  const cases: Array<[unknown, ReviewFlowErrorCode]> = [
    [new ForbiddenError("not_cohort_faculty"), "not_allowed"],
    [new ForbiddenError("attendanceRecord.correct"), "not_allowed"],
    [new ForbiddenError("attendance_finalized"), "register_finished"],
    [new ForbiddenError("correction_window_closed:7"), "window_closed"],
    [new Error("correction_reason_required"), "reason_required"],
    [new Error("unresolved_review_states:3"), "still_unresolved"],
    [new Error("session_status_conflict"), "register_changed"],
    [new Error("invalid_transition:FINALIZED->FINALIZED"), "register_finished"],
    [new Error("session_cancelled"), "register_closed"],
    [new Error("attendance_record_not_found"), "not_found"],
    [new Error("Minified React error #441"), "unknown"],
  ];
  for (const [error, code] of cases) assert.equal(reviewFlowErrorCode(error), code, String(error));
  for (const [, code] of cases) {
    const text = describeReviewFlowError(code);
    assert.ok(text.length > 0, code);
    assert.doesNotMatch(text, /Minified|#\d+|_/, code);
  }
});

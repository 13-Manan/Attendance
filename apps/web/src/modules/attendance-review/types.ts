import type { AttendanceCounts, IdentificationStatus } from "@attendance/shared-types";
import type { AttendanceResult, CorrectionSource } from "@/modules/attendance/types";
import type { AttendanceMode } from "@/modules/institutions/types";
import type { SessionStatus } from "@/modules/sessions/types";

export type { AttendanceCounts, AttendanceResult, CorrectionSource };

/**
 * Which enrolled population defines "the class" for this session.
 *
 * Mirrors `RecognitionRunSummary["candidateScope"]` on purpose: the roster
 * that gets attendance rows and the pool that recognition searched must be
 * the same set of people, or a student could be searched for and then not
 * given a row (or worse, given a row and never searched for).
 */
export type AttendanceRosterScope = "cohort" | "cohortSubject";

/**
 * Why a student is sitting in the Needs Review / Absent list. Rendered as
 * prose in the UI; kept as a closed vocabulary here so the reason is a fact
 * about the pipeline rather than a string some component invented.
 */
export type AttendanceReviewReason =
  | "low_confidence"
  | "ambiguous_match"
  /** Two distinct faces in one photograph both named this student. One person
   * is not in one still image twice, so this is the recogniser confusing
   * people — never a confident presence. */
  | "duplicate_in_capture"
  /** Compared against every detected face, and none of them was this student.
   * NOT absence: the student may have been behind somebody, facing away, or
   * outside the frame. Only a person may call that absence. */
  | "no_match"
  /** The captures contained no detectable face at all. Distinct from
   * `no_match`, which means faces were found and none was this student —
   * "we looked and saw nobody" is a different fact from "we saw people and
   * none was you", and a reviewer needs to be told which happened. */
  | "no_face_detected"
  /** Faces were detected but the captures were too poor to compare against.
   * A property of the photograph, not of the student. */
  | "low_quality"
  /** Like `low_quality`, for the most common and most fixable cause: the face
   * was too few pixels across to compare reliably. The remedy is a closer
   * photograph, so the reviewer is told that specifically. */
  | "face_too_small"
  | "no_face_template"
  | "incompatible_face_template"
  | "recognition_unavailable"
  /** Recognition ran and faces were counted, but the provider does not allow
   * identification (Azure Face Limited Access not granted). Nobody was
   * compared, so this is neither a match nor evidence of absence. */
  | "identification_unavailable"
  /** Recognition was attempted and failed outright. Distinct from
   * `recognition_unavailable`, which means it was never attempted. */
  | "recognition_error"
  | "manually_corrected"
  | null;

/**
 * What the machine proposes, separate from what has been decided.
 *
 * This is the whole point of the Phase 6 state split. A recognition result is
 * *evidence*, and evidence that nobody has acted on is not an attendance
 * result. `PRESENT` here means "the model believes this student is in the
 * room"; the register still records the student as unresolved until a person
 * confirms it, and `finalResult` is what carries that decision.
 *
 * There is deliberately no `ABSENT` suggestion. The model cannot produce
 * evidence of absence — it can only fail to find somebody, which has many
 * causes that are not the student being elsewhere.
 */
export type AttendanceSuggestion = "PRESENT" | null;

export interface AttendanceRosterStudent {
  studentId: string;
  studentCode: string;
  firstName: string;
  lastName: string;
}

/** One student as the review board shows them. */
export interface AttendanceReviewStudent extends AttendanceRosterStudent {
  attendanceRecordId: string;
  /** Two-letter monogram used for the avatar. The Student model carries no
   * photo column, so there is no profile photo to show — see
   * `photoUrl` below. */
  initials: string;
  /**
   * Always null in this build. The spec asks for a profile photo "if
   * available and permitted"; `Student` has no photo column and adding one
   * would be a schema change, so the UI falls back to an initials avatar.
   * The field exists so wiring a photo later is a data change, not a
   * component change.
   */
  photoUrl: string | null;
  /** Untouched AI advisory — preserved for the life of the record. */
  aiResult: AttendanceResult;
  aiConfidence: number | null;
  /** The authoritative, faculty-owned result. */
  finalResult: AttendanceResult;
  isManuallyCorrected: boolean;
  /** Human-facing explanation of how this student got here. */
  reason: AttendanceReviewReason;
  /** What the model proposed. `"PRESENT"` with a non-PRESENT `finalResult`
   * means an unconfirmed suggestion. */
  aiSuggestion: AttendanceSuggestion;
  /** True when recognition could not compare this student at all (no active
   * face template, or one enrolled under a different model build). Absence
   * for this student is "we never looked", not "we looked and they weren't
   * there" — the UI must say so. */
  wasComparable: boolean;
  /** Set when the best match was within the ambiguity margin of a runner-up. */
  wasAmbiguous: boolean;
  /** Which captured frame produced the winning score, e.g. "2:0". */
  bestFaceId: string | null;
}

export interface CaptureImageMetadata {
  sequenceNumber: number;
  facesDetected: number;
  qualityScore: number | null;
}

export interface RecognitionRunMetadata {
  modelName: string;
  modelVersion: string;
  productionEligible: boolean;
  candidateScope: AttendanceRosterScope;
  candidatePoolSize: number;
  detectedFacesTotal: number;
  scoredFacesTotal: number;
  skippedIncompatibleCandidates: number;
  presentMin: number;
  reviewMin: number;
  /** How many recognition passes the register combines: 1, plus one for each
   * photo the teacher added from the review screen. Absent on older rows. */
  rounds?: number;
  /** Distinct faces that resembled nobody in the class. Across several rounds
   * this is the largest single round's count — the same stranger in two
   * photos cannot be told apart from two strangers once the vectors are
   * gone, so the smaller, certain number is reported. */
  unknownFacesTotal?: number;
  /** Faces found but too small or unusable to compare at all. */
  rejectedFacesTotal?: number;
  /** Some faces were too small to compare reliably; a closer photo would help. */
  recommendRetake?: boolean;
  /** "gallery" for a provider-held gallery (Azure AI Face). Absent on older
   * rows, which are all "embedding". */
  templateKind?: "embedding" | "gallery";
  /** Gallery runs: whether identification was allowed. Anything but
   * "enabled" means the run counted faces and compared nobody. */
  identification?: IdentificationStatus;
}

/**
 * How the attendance rows for a session came to exist.
 *
 *   "recognition" — a recognition run produced advisory results.
 *   "manual"      — recognition was unavailable/declined and the faculty
 *                   member opened a roll call. Every student starts in
 *                   Needs Review; nothing is presumed.
 */
export type AttendanceGenerationSource = "recognition" | "manual";

/** Everything the review header needs about the session itself. */
export interface AttendanceSessionDetail {
  id: string;
  institutionId: string;
  institutionName: string;
  academicSessionId: string | null;
  academicSessionName: string | null;
  cohortId: string;
  cohortName: string;
  cohortTermLabel: string | null;
  attendanceMode: AttendanceMode;
  cohortSubjectId: string | null;
  subjectName: string | null;
  subjectCode: string | null;
  facultyUserId: string;
  facultyName: string | null;
  /** Calendar date of the class (ISO-8601). */
  sessionDate: string;
  /** When capture opened (ISO-8601). */
  startedAt: string;
  endedAt: string | null;
  /** The session state machine's position — OPEN…FINALIZED/CANCELLED. */
  processingStatus: SessionStatus;
  rosterScope: AttendanceRosterScope;
  generationSource: AttendanceGenerationSource | null;
  captureImages: CaptureImageMetadata[];
  recognition: RecognitionRunMetadata | null;
  finalizedByUserId: string | null;
  finalizedByName: string | null;
  finalizedAt: string | null;
}

export interface AttendanceReviewBoard {
  session: AttendanceSessionDetail;
  counts: AttendanceCounts;
  present: AttendanceReviewStudent[];
  absent: AttendanceReviewStudent[];
  needsReview: AttendanceReviewStudent[];
  /** False whenever finalization would silently convert an unresolved state
   * into a result. `finalizeBlockedReason` says why. */
  canFinalize: boolean;
  finalizeBlockedReason: string | null;
  /** Suggested-present rows that confirming the register will convert into a
   * faculty-owned PRESENT. */
  awaitingConfirmation: number;
  /** Rows nobody and nothing has resolved. These block confirmation. */
  awaitingDecision: number;
  /** True when the caller may actually press Confirm Attendance (permission
   * + state). Distinct from `canFinalize`, which is about the data. */
  actorCanFinalize: boolean;
  /** True when the caller may still change results after FINALIZED. */
  actorCanOverrideFinalized: boolean;
}

/**
 * One finalized class as the student's own portal shows it.
 *
 * Only FINALIZED sessions appear: before a faculty member confirms, an
 * attendance row is a working draft, and showing a student a provisional
 * "absent" that a correction is about to overturn would be worse than
 * showing them nothing.
 */
export interface StudentAttendanceEntry {
  attendanceRecordId: string;
  sessionId: string;
  sessionDate: string;
  finalizedAt: string | null;
  cohortName: string;
  subjectName: string | null;
  subjectCode: string | null;
  finalResult: AttendanceResult;
  /** True when a faculty member set this result by hand. Shown so a student
   * can tell a corrected record from an automatic one. */
  isManuallyCorrected: boolean;
}

export interface StudentAttendanceView {
  studentId: string;
  studentCode: string;
  fullName: string;
  entries: StudentAttendanceEntry[];
  /** Over the entries shown. Not an official attendance percentage — it
   * covers only the sessions in this list. */
  presentCount: number;
  absentCount: number;
}

export interface ReviewDecisionInput {
  attendanceRecordId: string;
  /** Only the three states a human may choose. NOT_EVALUATED is a pipeline
   * state, never a faculty decision. */
  newResult: Extract<AttendanceResult, "PRESENT" | "ABSENT" | "NEEDS_REVIEW">;
  reason?: string;
}

export interface ReviewDecisionResult {
  record: {
    id: string;
    sessionId: string;
    studentId: string;
    aiResult: AttendanceResult;
    aiConfidence: number | null;
    finalResult: AttendanceResult;
    isManuallyCorrected: boolean;
  };
  counts: AttendanceCounts;
}

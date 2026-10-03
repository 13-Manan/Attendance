/**
 * Twin / lookalike confirmations: staff deciding that two students whose faces
 * the enrollment check cannot tell apart are, in fact, different people.
 *
 * ## Where the state lives
 *
 * In the audit log, and nowhere else — no table was added for it.
 *
 * - A **conflict** is a `face_enrollment.refused` row with `refusal:
 *   "duplicate_identity"`. The enrollment service already writes one, naming
 *   both students, every time it refuses a face because it belongs to another
 *   enrolled student. Those rows are the queue.
 * - A **decision** is a `face_twin_confirmation.confirmed` or `.rejected` row,
 *   keyed on the pair: entityType `FaceIdentityPair`, entityId the two student
 *   ids sorted and joined with `~`. The latest one for a pair is its standing
 *   decision, so changing a decision is another row, never an edit, and the
 *   existing `(entityType, entityId)` index finds it.
 *
 * Nothing in the application updates or deletes an audit row. A decision that
 * cannot be read is treated as no decision, which leaves the pair blocked:
 * the failure is the safe one.
 *
 * ## Known twins, marked in advance
 *
 * Staff who already know two students are twins or lookalikes can say so
 * before either face is enrolled. That is the same decision — `confirmed`,
 * these are different people — on the same pair key, with `source:
 * "declared"` in the row, so the enrollment check needs nothing new: a face
 * landing in the duplicate band of a declared twin is let through for that
 * pair only, exactly as after a review, and no conflict is queued.
 * Attendance treats a declared pair as lookalikes — a match to either is
 * reviewed, never marked present on the recogniser's word
 * (modules/recognition-engine).
 *
 * Removing a declaration is a `withdrawn` row: the pair goes back to having
 * no decision, so a later collision is queued for review as if nothing had
 * been declared. Not `rejected` — that would block both students.
 */

export const PAIR_ENTITY_TYPE = "FaceIdentityPair";
export const TWIN_CONFIRMED_ACTION = "face_twin_confirmation.confirmed";
export const TWIN_REJECTED_ACTION = "face_twin_confirmation.rejected";
export const TWIN_WITHDRAWN_ACTION = "face_twin_confirmation.withdrawn";

export type TwinDecision = "confirmed" | "rejected";

/** Every kind of row in a pair's decision history; `withdrawn` stands for "no decision". */
export type TwinDecisionKind = TwinDecision | "withdrawn";

/** How a decision was made: in a review of a conflict, or declared in advance. */
export type TwinDecisionSource = "review" | "declared";

/** Where a pair stands: nobody has decided yet, or the latest decision. */
export type TwinPairState = "pending" | TwinDecision;

/** One standing decision, as the enrollment check needs it. */
export interface PairDecisionRecord {
  decision: TwinDecision;
  decidedByUserId: string | null;
  decidedAt: Date;
  /** The audit row that holds it, so an enrollment can say which one it relied on. */
  recordId: string;
}

/** A `duplicate_identity` refusal, as read from the audit log. */
export interface ConflictEvent {
  id: string;
  /** The student whose enrollment was refused. */
  blockedStudentId: string;
  /** The enrolled student the face matched. */
  matchedStudentId: string;
  at: Date;
  channel: "SELF" | "STAFF" | null;
}

/** A decision, as read from the audit log. */
export interface DecisionEvent {
  id: string;
  pair: string;
  decision: TwinDecisionKind;
  /** `declared` for a known pair marked in advance; absent, or `review`, for every other row. */
  source?: TwinDecisionSource;
  at: Date;
  byUserId: string | null;
}

/** A decision that stands: confirmed or rejected, never withdrawn. */
export type StandingDecision = DecisionEvent & { decision: TwinDecision };

/** Everything known about one pair, folded from its events. */
export interface PairConflict {
  pair: string;
  /** From the latest conflict: the student refused, and the one matched. */
  blockedStudentId: string;
  matchedStudentId: string;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  attempts: number;
  lastChannel: "SELF" | "STAFF" | null;
  /** The latest decision, or null while pending (none yet, or withdrawn). */
  decision: StandingDecision | null;
  state: TwinPairState;
}

/** A student on either side of a pair, as a reviewer sees them. Metadata only. */
export interface TwinStudentSummary {
  studentId: string;
  studentCode: string;
  firstName: string;
  lastName: string;
  onRoll: boolean;
  /** Current classes or sections, by name. */
  classes: string[];
  activeFaceSamples: number;
  lastFaceEnrolledAt: Date | null;
}

export interface TwinReviewItem {
  pair: string;
  state: TwinPairState;
  blocked: TwinStudentSummary;
  matched: TwinStudentSummary;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  attempts: number;
  lastChannel: "SELF" | "STAFF" | null;
  decidedAt: Date | null;
  decidedByName: string | null;
}

/** Who is looking, and over what. */
export type TwinReviewerKind = "institution" | "class_teacher" | "department";

export interface TwinReviewerView {
  kind: TwinReviewerKind;
  institutionType: "SCHOOL" | "COLLEGE";
  /** Set on a department's page. */
  department: { id: string; name: string } | null;
}

export interface TwinConfirmationList {
  reviewer: TwinReviewerView;
  pending: TwinReviewItem[];
  decided: TwinReviewItem[];
}

export interface TwinHistoryEntry {
  at: Date;
  kind: "conflict" | TwinDecisionKind;
  /** Decisions only: reviewed, or declared in advance. */
  source?: TwinDecisionSource;
  /** Conflicts: how the enrollment was attempted. Decisions: who decided. */
  detail: string;
}

export interface TwinConfirmationDetail {
  reviewer: TwinReviewerView;
  item: TwinReviewItem;
  history: TwinHistoryEntry[];
}

/** A student a reviewer may name in a declaration — for the picker. Metadata only. */
export interface TwinStudentOption {
  studentId: string;
  studentCode: string;
  firstName: string;
  lastName: string;
  /** Current classes or sections, by name. */
  classes: string[];
}

/** A pair staff marked as known twins or lookalikes, still standing. */
export interface KnownTwinPair {
  pair: string;
  students: [TwinStudentSummary, TwinStudentSummary];
  declaredAt: Date;
  declaredByName: string | null;
}

export interface KnownTwinPairList {
  reviewer: TwinReviewerView;
  pairs: KnownTwinPair[];
  /** The students this reviewer may pair, on roll and in their scope. */
  students: TwinStudentOption[];
}

/** One student's known pairs, for their record — as far as this reviewer can see. */
export interface StudentKnownTwins {
  reviewer: TwinReviewerView;
  /** False when the student is off roll: nothing can be declared for them. */
  canDeclare: boolean;
  pairs: Array<{ pair: string; other: TwinStudentSummary; declaredAt: Date; declaredByName: string | null }>;
}

/** What a declaration did. */
export interface DeclareKnownTwinResult {
  /** True when this call recorded the declaration; false when the pair already stood confirmed. */
  changed: boolean;
  /** How the standing confirmation was made — `review` when an earlier review already confirmed the pair. */
  source: TwinDecisionSource;
  students: [TwinStudentSummary, TwinStudentSummary];
}

/** A refusal a reviewer can be shown: not found, not yours, not reviewable. */
export class TwinConfirmationError extends Error {}

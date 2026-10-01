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
 */

export const PAIR_ENTITY_TYPE = "FaceIdentityPair";
export const TWIN_CONFIRMED_ACTION = "face_twin_confirmation.confirmed";
export const TWIN_REJECTED_ACTION = "face_twin_confirmation.rejected";

export type TwinDecision = "confirmed" | "rejected";

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
  decision: TwinDecision;
  at: Date;
  byUserId: string | null;
}

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
  /** The latest decision, or null while pending. */
  decision: DecisionEvent | null;
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
  kind: "conflict" | TwinDecision;
  /** Conflicts: how the enrollment was attempted. Decisions: who decided. */
  detail: string;
}

export interface TwinConfirmationDetail {
  reviewer: TwinReviewerView;
  item: TwinReviewItem;
  history: TwinHistoryEntry[];
}

/** A refusal a reviewer can be shown: not found, not yours, not reviewable. */
export class TwinConfirmationError extends Error {}

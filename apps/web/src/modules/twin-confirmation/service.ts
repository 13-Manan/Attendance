import type { SessionUser } from "@/modules/auth-tenancy/types";
import { hasAnyPermission, hasPermission } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { blockedStateOf, foldPairs, orderForQueue, pairKey, parsePairKey } from "./policy";
import * as repo from "./repository";
import {
  TwinConfirmationError,
  type PairConflict,
  type TwinConfirmationDetail,
  type TwinConfirmationList,
  type TwinDecision,
  type TwinHistoryEntry,
  type TwinReviewItem,
  type TwinReviewerKind,
  type TwinReviewerView,
  type TwinStudentSummary,
} from "./types";

/**
 * Twin / lookalike confirmations: the staff side.
 *
 * ## Who may decide
 *
 * Somebody with authority over BOTH students — they see both names, both
 * classes, and decide something about both identities:
 *
 * - **Institution-wide** — a principal, a director, an administrator: anyone
 *   holding `faceEmbedding.manage`, the permission that already decides whose
 *   face is enrolled at this institution.
 * - **A school's class teacher** — holds `student.update` (the Class Teacher
 *   role's student-record authority) and is the class teacher, the primary
 *   teacher, of a current class each student is in.
 * - **A college head of department** — the head of the department whose
 *   current sections both students are in (college-setup's own test).
 *
 * Nobody else: not a student, not a teacher of the class, not a department's
 * faculty, not an attendance operator. A pair across two classes or two
 * departments is the principal's or the director's.
 *
 * ## What a decision does
 *
 * Only what the enrollment check asks of it (`pairDecisionFor`): when a face
 * lands in the duplicate band of another student, a standing `confirmed`
 * between exactly those two lets the sample through, and anything else
 * refuses it. Nothing about recognition changes, and no other pair is touched.
 */

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface TwinConfirmationDeps {
  getInstitutionType?: (institutionId: string) => Promise<"SCHOOL" | "COLLEGE" | null>;
  listConflicts?: typeof repo.listConflicts;
  listDecisions?: typeof repo.listDecisions;
  studentSummaries?: typeof repo.studentSummaries;
  studentsInClassesTaughtBy?: typeof repo.studentsInClassesTaughtBy;
  isClassTeacherAnywhere?: typeof repo.isClassTeacherAnywhere;
  userNames?: typeof repo.userNames;
  recordDecision?: typeof repo.recordDecision;
  /** College: the department's scope check and which of the students are its. */
  departmentStudentsAmong?: (
    actor: SessionUser,
    departmentId: string,
    studentIds: readonly string[],
  ) => Promise<{ scope: { kind: "admin" | "hod" }; department: { id: string; name: string }; studentIds: Set<string> }>;
}

function defaults() {
  return {
    getInstitutionType: async (institutionId: string) => {
      const { getInstitutionType } = await import("@/modules/institutions/repository");
      const type = await getInstitutionType(institutionId);
      return type === "SCHOOL" || type === "COLLEGE" ? type : null;
    },
    listConflicts: repo.listConflicts,
    listDecisions: repo.listDecisions,
    studentSummaries: repo.studentSummaries,
    studentsInClassesTaughtBy: repo.studentsInClassesTaughtBy,
    isClassTeacherAnywhere: repo.isClassTeacherAnywhere,
    userNames: repo.userNames,
    recordDecision: repo.recordDecision,
    departmentStudentsAmong: async (actor: SessionUser, departmentId: string, studentIds: readonly string[]) => {
      const { departmentStudentsAmong } = await import("@/modules/college-setup/service");
      return departmentStudentsAmong(actor, departmentId, studentIds);
    },
  };
}

function deps(overrides: TwinConfirmationDeps) {
  return { ...defaults(), ...overrides };
}

type ResolvedDeps = ReturnType<typeof deps>;

/** Where the reviewer is looking from: the institution's Students area, or one department's. */
export interface TwinReviewContext {
  departmentId?: string;
}

// ---------------------------------------------------------------------------
// Who is reviewing
// ---------------------------------------------------------------------------

interface Reviewer {
  kind: TwinReviewerKind;
  institutionId: string;
  institutionType: "SCHOOL" | "COLLEGE";
  userId: string;
  department: { id: string; name: string } | null;
  /** Which of these students this reviewer may see and decide about. */
  covers: (studentIds: readonly string[]) => Promise<Set<string>>;
}

async function resolveReviewer(actor: SessionUser, context: TwinReviewContext, d: ResolvedDeps): Promise<Reviewer> {
  const institutionId = actor.institutionId;
  if (!institutionId) throw new ForbiddenError("no_institution");
  const institutionType = await d.getInstitutionType(institutionId);
  if (!institutionType) throw new ForbiddenError("no_institution");

  if (context.departmentId !== undefined) {
    if (institutionType !== "COLLEGE") throw new ForbiddenError("not_a_college");
    const departmentId = context.departmentId;
    // Resolves the actor's scope before anything else: a head of another
    // department, or anyone who is neither a head nor an administrator, is
    // refused here.
    const probe = await d.departmentStudentsAmong(actor, departmentId, []);
    const kind: TwinReviewerKind = probe.scope.kind === "admin" ? "institution" : "department";
    return {
      kind,
      institutionId,
      institutionType,
      userId: actor.userId,
      department: probe.department,
      // On a department's page, the department's pairs — for its head and for
      // an administrator alike.
      covers: async (studentIds) => (await d.departmentStudentsAmong(actor, departmentId, studentIds)).studentIds,
    };
  }

  // An administrator, or a receptionist the administrator explicitly granted
  // twin decisions to (`twinConfirmation.decide`, off by default — enrolling
  // faces does not imply it).
  if (hasAnyPermission(actor, "faceEmbedding.manage", "twinConfirmation.decide")) {
    return {
      kind: "institution",
      institutionId,
      institutionType,
      userId: actor.userId,
      department: null,
      covers: async (studentIds) => new Set(studentIds),
    };
  }

  if (
    institutionType === "SCHOOL" &&
    hasPermission(actor, "student.update") &&
    (await d.isClassTeacherAnywhere(institutionId, actor.userId))
  ) {
    return {
      kind: "class_teacher",
      institutionId,
      institutionType,
      userId: actor.userId,
      department: null,
      covers: (studentIds) => d.studentsInClassesTaughtBy(institutionId, actor.userId, studentIds),
    };
  }

  throw new ForbiddenError("twin_confirmation.review");
}

function viewOf(reviewer: Reviewer): TwinReviewerView {
  return { kind: reviewer.kind, institutionType: reviewer.institutionType, department: reviewer.department };
}

/**
 * Whether this account may review twin confirmations at all — for showing the
 * way in. Never throws; the pages themselves check again.
 */
export async function canReviewTwinConfirmations(
  actor: SessionUser,
  context: TwinReviewContext = {},
  overrides: TwinConfirmationDeps = {},
): Promise<boolean> {
  try {
    await resolveReviewer(actor, context, deps(overrides));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function loadItems(
  reviewer: Reviewer,
  pairs: readonly PairConflict[],
  d: ResolvedDeps,
): Promise<TwinReviewItem[]> {
  const ids = [...new Set(pairs.flatMap((pair) => [pair.blockedStudentId, pair.matchedStudentId]))];
  const [summaries, covered] = await Promise.all([d.studentSummaries(reviewer.institutionId, ids), reviewer.covers(ids)]);
  const names = await d.userNames(
    reviewer.institutionId,
    pairs.map((pair) => pair.decision?.byUserId).filter((id): id is string => typeof id === "string"),
  );

  const items: TwinReviewItem[] = [];
  for (const pair of pairs) {
    const blocked = summaries.get(pair.blockedStudentId);
    const matched = summaries.get(pair.matchedStudentId);
    // A pair is shown only when the reviewer has authority over both students
    // and both are still on roll: a student taken off roll is out of
    // recognition and out of the enrollment check, so there is nothing left
    // to confirm.
    if (!blocked || !matched || !blocked.onRoll || !matched.onRoll) continue;
    if (!covered.has(blocked.studentId) || !covered.has(matched.studentId)) continue;
    items.push(toItem(pair, blocked, matched, names));
  }
  return items;
}

function toItem(
  pair: PairConflict,
  blocked: TwinStudentSummary,
  matched: TwinStudentSummary,
  names: Map<string, string>,
): TwinReviewItem {
  return {
    pair: pair.pair,
    state: pair.state,
    blocked,
    matched,
    firstDetectedAt: pair.firstDetectedAt,
    lastDetectedAt: pair.lastDetectedAt,
    attempts: pair.attempts,
    lastChannel: pair.lastChannel,
    decidedAt: pair.decision?.at ?? null,
    decidedByName: pair.decision?.byUserId ? (names.get(pair.decision.byUserId) ?? null) : null,
  };
}

/** The queue: pending pairs to work through, and decided ones to look up. */
export async function listTwinConfirmations(
  actor: SessionUser,
  context: TwinReviewContext = {},
  overrides: TwinConfirmationDeps = {},
): Promise<TwinConfirmationList> {
  const d = deps(overrides);
  const reviewer = await resolveReviewer(actor, context, d);
  const [conflicts, decisions] = await Promise.all([
    d.listConflicts(reviewer.institutionId),
    d.listDecisions(reviewer.institutionId),
  ]);
  const items = await loadItems(reviewer, foldPairs(conflicts, decisions), d);
  return { reviewer: viewOf(reviewer), ...orderForQueue(items) };
}

/** How many pairs are waiting for this reviewer. Zero on any failure — it only decorates a link. */
export async function pendingTwinConfirmationCount(
  actor: SessionUser,
  context: TwinReviewContext = {},
  overrides: TwinConfirmationDeps = {},
): Promise<number> {
  try {
    return (await listTwinConfirmations(actor, context, overrides)).pending.length;
  } catch {
    return 0;
  }
}

async function loadPair(
  reviewer: Reviewer,
  pair: string,
  d: ResolvedDeps,
): Promise<{
  conflict: PairConflict;
  item: TwinReviewItem;
  events: Awaited<ReturnType<typeof repo.listConflicts>>;
  decisions: Awaited<ReturnType<typeof repo.listDecisions>>;
}> {
  const ids = parsePairKey(pair);
  if (!ids) throw new TwinConfirmationError("That confirmation does not exist.");
  const [conflicts, decisions] = await Promise.all([
    d.listConflicts(reviewer.institutionId, { blockedStudentIds: ids }),
    d.listDecisions(reviewer.institutionId, { pairs: [pair] }),
  ]);
  const mine = conflicts.filter((event) => ids.includes(event.matchedStudentId));
  const conflict = foldPairs(mine, decisions).find((candidate) => candidate.pair === pair);
  if (!conflict) throw new TwinConfirmationError("That confirmation does not exist.");
  const [item] = await loadItems(reviewer, [conflict], d);
  if (!item) {
    // One answer for "not yours" and "no longer on roll": either way there is
    // nothing this reviewer can do here, and saying which would leak whether
    // a student outside their scope exists.
    throw new TwinConfirmationError("That confirmation is not one you can review.");
  }
  return { conflict, item, events: mine, decisions };
}

/** One pair, for the review screen: both students and what happened, when. */
export async function getTwinConfirmation(
  actor: SessionUser,
  pair: string,
  context: TwinReviewContext = {},
  overrides: TwinConfirmationDeps = {},
): Promise<TwinConfirmationDetail> {
  const d = deps(overrides);
  const reviewer = await resolveReviewer(actor, context, d);
  const { item, events, decisions } = await loadPair(reviewer, pair, d);
  const names = await d.userNames(
    reviewer.institutionId,
    decisions.map((decision) => decision.byUserId).filter((id): id is string => typeof id === "string"),
  );

  const nameOf = (studentId: string) => {
    const student = studentId === item.blocked.studentId ? item.blocked : item.matched;
    return `${student.firstName} ${student.lastName}`.trim();
  };
  const history: TwinHistoryEntry[] = [
    ...events.map((event) => ({
      at: event.at,
      kind: "conflict" as const,
      detail: `${nameOf(event.blockedStudentId)}'s face matched ${nameOf(event.matchedStudentId)} ${
        event.channel === "SELF" ? "during self-enrollment" : event.channel === "STAFF" ? "during staff enrollment" : ""
      }`.trim(),
    })),
    ...decisions.map((decision) => ({
      at: decision.at,
      kind: decision.decision,
      detail: decision.byUserId ? (names.get(decision.byUserId) ?? "A member of staff") : "A member of staff",
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return { reviewer: viewOf(reviewer), item, history };
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

export interface DecideTwinInput {
  pair: string;
  decision: TwinDecision;
}

/**
 * Records a decision about one pair.
 *
 * Everything is resolved here, from the key and the session: the two students
 * come from the conflict the enrollment check recorded, so a decision can only
 * ever be about a pair that actually collided, and only by a reviewer with
 * authority over both. Deciding what is already decided writes nothing.
 */
export async function decideTwinConfirmation(
  actor: SessionUser,
  input: DecideTwinInput,
  context: TwinReviewContext = {},
  overrides: TwinConfirmationDeps = {},
): Promise<{ state: TwinDecision; changed: boolean }> {
  if (input.decision !== "confirmed" && input.decision !== "rejected") {
    throw new TwinConfirmationError("Choose whether these are different people.");
  }
  const d = deps(overrides);
  const reviewer = await resolveReviewer(actor, context, d);
  const { conflict } = await loadPair(reviewer, input.pair, d);

  const previous = conflict.decision?.decision ?? null;
  if (previous === input.decision) return { state: input.decision, changed: false };

  const ids = parsePairKey(input.pair)!;
  await d.recordDecision({
    institutionId: reviewer.institutionId,
    actorUserId: actor.userId,
    pair: input.pair,
    studentIds: ids,
    blockedStudentId: conflict.blockedStudentId,
    matchedStudentId: conflict.matchedStudentId,
    decision: input.decision,
    previous,
    reviewerScope: reviewer.kind,
    departmentId: reviewer.department?.id ?? null,
  });
  return { state: input.decision, changed: true };
}

// ---------------------------------------------------------------------------
// For other modules
// ---------------------------------------------------------------------------

/**
 * A student's own standing as the refused side of a conflict — for their
 * enrollment page and the verification checklist. No other student's identity
 * is part of the answer. Null when they have never been refused for one.
 */
export async function twinBlockStates(
  institutionId: string,
  studentIds: readonly string[],
  overrides: Pick<TwinConfirmationDeps, "listConflicts" | "listDecisions"> = {},
): Promise<Map<string, "pending" | "not_confirmed" | "confirmed">> {
  const d = deps(overrides);
  const conflicts = await d.listConflicts(institutionId, { blockedStudentIds: studentIds });
  if (conflicts.length === 0) return new Map();
  const pairs = [...new Set(conflicts.map((event) => pairKey(event.blockedStudentId, event.matchedStudentId)))];
  const decisions = await d.listDecisions(institutionId, { pairs });
  const folded = foldPairs(conflicts, decisions);
  const states = new Map<string, "pending" | "not_confirmed" | "confirmed">();
  for (const studentId of studentIds) {
    const state = blockedStateOf(folded, studentId);
    if (state) states.set(studentId, state);
  }
  return states;
}

export { pairKey, parsePairKey };
export { latestPairDecision as pairDecisionFor } from "./repository";

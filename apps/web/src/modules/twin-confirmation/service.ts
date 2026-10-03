import type { SessionUser } from "@/modules/auth-tenancy/types";
import { hasAnyPermission, hasPermission } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { blockedStateOf, declaredPairs, foldPairs, orderForQueue, pairKey, parsePairKey } from "./policy";
import * as repo from "./repository";
import {
  TwinConfirmationError,
  type DeclareKnownTwinResult,
  type KnownTwinPair,
  type KnownTwinPairList,
  type PairConflict,
  type StudentKnownTwins,
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
 *
 * ## Known pairs, declared in advance
 *
 * The same people may also mark two students as known twins or lookalikes
 * before the enrollment check ever meets them (`declareKnownTwinPair`). The
 * declaration is that same `confirmed` decision, marked `declared`, so
 * enrollment treats it exactly like a confirmation from a review. One more
 * thing reads it: a recognition run treats a declared pair in its class as
 * lookalikes (`knownTwinPairsInClass`), so a match to either is reviewed —
 * the declaration never makes either of them more likely to be marked present.
 * Removing it (`withdrawKnownTwinPair`) leaves the pair with no decision.
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
  standingDecision?: (institutionId: string, pair: string, client?: unknown) => ReturnType<typeof repo.standingDecision>;
  recordDeclaration?: (input: repo.RecordDeclarationInput, client?: unknown) => Promise<void>;
  recordWithdrawal?: (input: repo.RecordWithdrawalInput, client?: unknown) => Promise<void>;
  /** Runs the read-then-write of one pair under that pair's lock. */
  withPairLock?: <T>(institutionId: string, pair: string, fn: (client: unknown) => Promise<T>) => Promise<T>;
  onRollStudentIds?: typeof repo.onRollStudentIds;
  studentOptions?: typeof repo.studentOptions;
  studentsOnRollInClass?: typeof repo.studentsOnRollInClass;
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
    standingDecision: (institutionId: string, pair: string, client?: unknown) =>
      repo.standingDecision(institutionId, pair, client as Parameters<typeof repo.standingDecision>[2]),
    recordDeclaration: (input: repo.RecordDeclarationInput, client?: unknown) =>
      repo.recordDeclaration(input, client as Parameters<typeof repo.recordDeclaration>[1]),
    recordWithdrawal: (input: repo.RecordWithdrawalInput, client?: unknown) =>
      repo.recordWithdrawal(input, client as Parameters<typeof repo.recordWithdrawal>[1]),
    withPairLock: <T>(institutionId: string, pair: string, fn: (client: unknown) => Promise<T>) =>
      repo.withPairLock(institutionId, pair, fn),
    onRollStudentIds: repo.onRollStudentIds,
    studentOptions: repo.studentOptions,
    studentsOnRollInClass: repo.studentsOnRollInClass,
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
      source: decision.source ?? "review",
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
// Known pairs, declared in advance
// ---------------------------------------------------------------------------

/**
 * One answer for every student a declaration cannot name: not found, at
 * another institution, off roll, or outside this reviewer's classes or
 * department. Saying which would tell a class teacher whether a student
 * elsewhere exists.
 */
const NOT_DECLARABLE = "Those students can't be marked here. Choose two students on roll that you are responsible for.";

const STUDENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Both students, on roll, in this reviewer's scope — or the one refusal. */
async function declarablePair(
  reviewer: Reviewer,
  studentIds: readonly [string, string],
  d: ResolvedDeps,
): Promise<[TwinStudentSummary, TwinStudentSummary]> {
  const [a, b] = studentIds;
  const [summaries, covered] = await Promise.all([
    d.studentSummaries(reviewer.institutionId, [a, b]),
    reviewer.covers([a, b]),
  ]);
  const first = summaries.get(a);
  const second = summaries.get(b);
  if (!first || !second || !first.onRoll || !second.onRoll || !covered.has(a) || !covered.has(b)) {
    throw new TwinConfirmationError(NOT_DECLARABLE);
  }
  return [first, second];
}

/** The two ids a request named, checked for shape, or the one refusal. */
function requestedPair(studentIds: unknown): [string, string] {
  if (!Array.isArray(studentIds) || studentIds.length !== 2) {
    throw new TwinConfirmationError("Choose two students.");
  }
  const [a, b] = studentIds.map((value) => (typeof value === "string" ? value.trim() : ""));
  if (a === "" || b === "") throw new TwinConfirmationError("Choose two students.");
  if (a === b) throw new TwinConfirmationError("Choose two different students.");
  if (!STUDENT_ID.test(a) || !STUDENT_ID.test(b)) throw new TwinConfirmationError(NOT_DECLARABLE);
  return [a, b];
}

/**
 * Marks two students as known twins or lookalikes, ahead of the enrollment
 * check: these are different people who look alike.
 *
 * Authority is the review's own — `resolveReviewer` — over both students, who
 * must both be on roll. The pair is read and written under its lock, so a
 * declaration made twice, or by two people at once, either way round, records
 * one row. A pair already confirmed — declared, or in a review — is left as it
 * stands and reported unchanged. A pair a review recorded as not confirmed is
 * refused here: that decision is changed where it was made.
 */
export async function declareKnownTwinPair(
  actor: SessionUser,
  input: { studentIds: unknown },
  context: TwinReviewContext = {},
  overrides: TwinConfirmationDeps = {},
): Promise<DeclareKnownTwinResult> {
  const d = deps(overrides);
  const reviewer = await resolveReviewer(actor, context, d);
  const ids = requestedPair(input.studentIds);
  const students = await declarablePair(reviewer, ids, d);
  const pair = pairKey(ids[0], ids[1]);
  const sorted = parsePairKey(pair)!;
  // Ordered as the key is, whichever way round they were chosen.
  const ordered: [TwinStudentSummary, TwinStudentSummary] =
    students[0].studentId === sorted[0] ? students : [students[1], students[0]];

  return d.withPairLock(reviewer.institutionId, pair, async (client) => {
    const standing = await d.standingDecision(reviewer.institutionId, pair, client);
    if (standing?.decision === "confirmed") {
      return { changed: false, source: standing.source ?? "review", students: ordered };
    }
    if (standing?.decision === "rejected") {
      throw new TwinConfirmationError(
        "These two were reviewed and recorded as not confirmed. To change that, open the pair under Decided and decide again.",
      );
    }
    await d.recordDeclaration(
      {
        institutionId: reviewer.institutionId,
        actorUserId: actor.userId,
        pair,
        studentIds: sorted,
        previous: standing?.decision === "withdrawn" ? "withdrawn" : null,
        reviewerScope: reviewer.kind,
        departmentId: reviewer.department?.id ?? null,
      },
      client,
    );
    return { changed: true, source: "declared" as const, students: ordered };
  });
}

/**
 * Removes a declaration: the pair has no decision again, so the enrollment
 * check treats a collision between them like any other — refused and queued
 * for review — and attendance no longer treats them as lookalikes unless
 * their own faces say so. Nothing else changes: no face sample, register or
 * student record is touched.
 *
 * Only a declaration can be removed here. A pair confirmed in a review is
 * changed in that review, as it always has been.
 */
export async function withdrawKnownTwinPair(
  actor: SessionUser,
  input: { pair: unknown },
  context: TwinReviewContext = {},
  overrides: TwinConfirmationDeps = {},
): Promise<{ changed: boolean }> {
  const d = deps(overrides);
  const reviewer = await resolveReviewer(actor, context, d);
  const ids = parsePairKey(input.pair);
  if (!ids) throw new TwinConfirmationError(NOT_DECLARABLE);
  await declarablePair(reviewer, ids, d);
  const pair = pairKey(ids[0], ids[1]);

  return d.withPairLock(reviewer.institutionId, pair, async (client) => {
    const standing = await d.standingDecision(reviewer.institutionId, pair, client);
    if (!standing || standing.decision === "withdrawn") return { changed: false };
    if (standing.decision !== "confirmed" || standing.source !== "declared") {
      throw new TwinConfirmationError(
        "This pair was decided in a review, not marked in advance. Change it from the pair under Decided.",
      );
    }
    await d.recordWithdrawal(
      {
        institutionId: reviewer.institutionId,
        actorUserId: actor.userId,
        pair,
        studentIds: ids,
        reviewerScope: reviewer.kind,
        departmentId: reviewer.department?.id ?? null,
      },
      client,
    );
    return { changed: true };
  });
}

/** Declared pairs this reviewer can see: both students on roll and in their scope. */
async function visibleDeclaredPairs(reviewer: Reviewer, d: ResolvedDeps, onlyStudentId?: string): Promise<KnownTwinPair[]> {
  const declared = [...declaredPairs(await d.listDecisions(reviewer.institutionId)).values()].filter(
    (decision) => !onlyStudentId || parsePairKey(decision.pair)!.includes(onlyStudentId),
  );
  if (declared.length === 0) return [];
  const ids = [...new Set(declared.flatMap((decision) => parsePairKey(decision.pair)!))];
  const [summaries, covered] = await Promise.all([d.studentSummaries(reviewer.institutionId, ids), reviewer.covers(ids)]);
  const names = await d.userNames(
    reviewer.institutionId,
    declared.map((decision) => decision.byUserId).filter((id): id is string => typeof id === "string"),
  );
  const pairs: KnownTwinPair[] = [];
  for (const decision of declared) {
    const [a, b] = parsePairKey(decision.pair)!;
    const first = summaries.get(a);
    const second = summaries.get(b);
    // Off roll is out of enrollment and recognition alike, so the pair has
    // nothing to apply to; it is kept on record and shown again if they return.
    if (!first || !second || !first.onRoll || !second.onRoll) continue;
    if (!covered.has(a) || !covered.has(b)) continue;
    pairs.push({
      pair: decision.pair,
      students: [first, second],
      declaredAt: decision.at,
      declaredByName: decision.byUserId ? (names.get(decision.byUserId) ?? null) : null,
    });
  }
  return pairs.sort((x, y) => y.declaredAt.getTime() - x.declaredAt.getTime());
}

/**
 * The known pairs on a Twin / Lookalike page, and the students its reviewer
 * may pair — the same scope as the review queue beside it.
 */
export async function listKnownTwinPairs(
  actor: SessionUser,
  context: TwinReviewContext = {},
  overrides: TwinConfirmationDeps = {},
): Promise<KnownTwinPairList> {
  const d = deps(overrides);
  const reviewer = await resolveReviewer(actor, context, d);
  const [pairs, onRoll] = await Promise.all([
    visibleDeclaredPairs(reviewer, d),
    d.onRollStudentIds(reviewer.institutionId),
  ]);
  const covered = await reviewer.covers(onRoll);
  const students = await d.studentOptions(reviewer.institutionId, [...covered]);
  return { reviewer: viewOf(reviewer), pairs, students };
}

/**
 * One student's known pairs, for their record — or null when this viewer may
 * not manage twin pairs for them (not a reviewer, or the student is outside
 * their classes or department). Only pairs whose other student is also in the
 * viewer's scope are listed.
 */
export async function knownTwinsOfStudent(
  actor: SessionUser,
  studentId: string,
  context: TwinReviewContext = {},
  overrides: TwinConfirmationDeps = {},
): Promise<StudentKnownTwins | null> {
  const d = deps(overrides);
  let reviewer: Reviewer;
  try {
    reviewer = await resolveReviewer(actor, context, d);
  } catch (error) {
    if (error instanceof ForbiddenError) return null;
    throw error;
  }
  const [summaries, covered] = await Promise.all([
    d.studentSummaries(reviewer.institutionId, [studentId]),
    reviewer.covers([studentId]),
  ]);
  const student = summaries.get(studentId);
  if (!student || !covered.has(studentId)) return null;
  const pairs = await visibleDeclaredPairs(reviewer, d, studentId);
  return {
    reviewer: viewOf(reviewer),
    canDeclare: student.onRoll,
    pairs: pairs.map((pair) => ({
      pair: pair.pair,
      other: pair.students[0].studentId === studentId ? pair.students[1] : pair.students[0],
      declaredAt: pair.declaredAt,
      declaredByName: pair.declaredByName,
    })),
  };
}

// ---------------------------------------------------------------------------
// For other modules
// ---------------------------------------------------------------------------

/**
 * The declared pairs a recognition run of this class must treat as
 * lookalikes: both students on roll with an ACTIVE enrollment in the class,
 * whether or not either has a face enrolled yet — a twin with no samples is
 * exactly the one the recogniser would mistake for the other.
 *
 * Read from the database on every run, never cached. Throws if it cannot be
 * read: a run that does not know who the twins are must not mark either of
 * them present, so the run fails and the teacher retries or marks by hand.
 */
export async function knownTwinPairsInClass(
  institutionId: string,
  cohortId: string,
  overrides: Pick<TwinConfirmationDeps, "listDecisions" | "studentsOnRollInClass"> = {},
): Promise<Array<[string, string]>> {
  const d = deps(overrides);
  const declared = [...declaredPairs(await d.listDecisions(institutionId)).keys()].map((pair) => parsePairKey(pair)!);
  if (declared.length === 0) return [];
  const inClass = await d.studentsOnRollInClass(institutionId, cohortId, [...new Set(declared.flat())]);
  return declared.filter(([a, b]) => inClass.has(a) && inClass.has(b));
}

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

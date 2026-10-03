import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import { pairKey } from "./policy";
import {
  PAIR_ENTITY_TYPE,
  TWIN_CONFIRMED_ACTION,
  TWIN_REJECTED_ACTION,
  TWIN_WITHDRAWN_ACTION,
  type ConflictEvent,
  type DecisionEvent,
  type PairDecisionRecord,
  type TwinDecision,
  type TwinDecisionKind,
  type TwinStudentOption,
  type TwinStudentSummary,
} from "./types";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Reads and writes for twin confirmations. Everything here is the audit log or
 * plain student metadata: no face template, vector or image is read.
 */

const REFUSED_ACTION = "face_enrollment.refused";

/**
 * The most refusals one queue read looks at. Conflicts are rare — they need a
 * face in the duplicate band of an enrolled student — so this is a guard
 * against a pathological log, not a page size.
 */
const CONFLICT_SCAN_LIMIT = 5000;

// A withdrawal is read with the decisions: it is the latest row of a pair whose
// declaration was removed, and must stand in front of the declaration it ends.
const DECISION_ACTIONS = [TWIN_CONFIRMED_ACTION, TWIN_REJECTED_ACTION, TWIN_WITHDRAWN_ACTION];

function kindOf(action: string): TwinDecisionKind {
  if (action === TWIN_CONFIRMED_ACTION) return "confirmed";
  if (action === TWIN_WITHDRAWN_ACTION) return "withdrawn";
  return "rejected";
}

function toConflict(row: {
  id: string;
  entityId: string;
  createdAt: Date;
  afterJson: Prisma.JsonValue;
}): ConflictEvent | null {
  const after = (row.afterJson ?? {}) as Record<string, unknown>;
  const matched = after.collidedWithStudentId;
  if (typeof matched !== "string" || matched === "") return null;
  const channel = after.channel === "SELF" || after.channel === "STAFF" ? after.channel : null;
  return { id: row.id, blockedStudentId: row.entityId, matchedStudentId: matched, at: row.createdAt, channel };
}

function toDecision(row: {
  id: string;
  entityId: string;
  action: string;
  createdAt: Date;
  actorUserId: string | null;
  afterJson: Prisma.JsonValue;
}): DecisionEvent {
  const after = (row.afterJson ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    pair: row.entityId,
    decision: kindOf(row.action),
    source: after.source === "declared" ? "declared" : "review",
    at: row.createdAt,
    byUserId: row.actorUserId,
  };
}

const CONFLICT_SELECT = { id: true, entityId: true, createdAt: true, afterJson: true } as const;
const DECISION_SELECT = { id: true, entityId: true, action: true, createdAt: true, actorUserId: true, afterJson: true } as const;

/**
 * `duplicate_identity` refusals at this institution — all of them, or only
 * those refusing these students.
 */
export async function listConflicts(
  institutionId: string,
  options: { blockedStudentIds?: readonly string[] } = {},
  client: Client = prisma,
): Promise<ConflictEvent[]> {
  if (options.blockedStudentIds && options.blockedStudentIds.length === 0) return [];
  const rows = await client.auditLog.findMany({
    where: {
      institutionId,
      action: REFUSED_ACTION,
      entityType: "Student",
      ...(options.blockedStudentIds ? { entityId: { in: [...options.blockedStudentIds] } } : {}),
      afterJson: { path: ["refusal"], equals: "duplicate_identity" },
    },
    select: CONFLICT_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: CONFLICT_SCAN_LIMIT,
  });
  return rows.map(toConflict).filter((event): event is ConflictEvent => event !== null);
}

/** Decisions at this institution — all of them, or only about these pairs. */
export async function listDecisions(
  institutionId: string,
  options: { pairs?: readonly string[] } = {},
  client: Client = prisma,
): Promise<DecisionEvent[]> {
  if (options.pairs && options.pairs.length === 0) return [];
  const rows = await client.auditLog.findMany({
    where: {
      institutionId,
      entityType: PAIR_ENTITY_TYPE,
      action: { in: DECISION_ACTIONS },
      ...(options.pairs ? { entityId: { in: [...options.pairs] } } : {}),
    },
    select: DECISION_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rows.map(toDecision);
}

/** A pair's latest decision row, whatever its kind — or null if there has never been one. */
export async function standingDecision(
  institutionId: string,
  pair: string,
  client: Client = prisma,
): Promise<DecisionEvent | null> {
  const row = await client.auditLog.findFirst({
    where: { entityType: PAIR_ENTITY_TYPE, entityId: pair, institutionId, action: { in: DECISION_ACTIONS } },
    select: DECISION_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return row ? toDecision(row) : null;
}

/**
 * The standing decision about two students, or null if nobody has decided.
 * What the enrollment check asks when a face lands in the duplicate band of
 * another student — one indexed read. A confirmation made in a review and one
 * declared in advance read the same: these are different people. A withdrawn
 * declaration is no decision at all, so the sample is refused and the
 * conflict queued, as for a pair nobody has ever looked at.
 */
export async function latestPairDecision(
  institutionId: string,
  studentId: string,
  otherStudentId: string,
  client: Client = prisma,
): Promise<PairDecisionRecord | null> {
  const decision = await standingDecision(institutionId, pairKey(studentId, otherStudentId), client);
  if (!decision || decision.decision === "withdrawn") return null;
  return { decision: decision.decision, decidedByUserId: decision.byUserId, decidedAt: decision.at, recordId: decision.id };
}

export interface RecordDecisionInput {
  institutionId: string;
  actorUserId: string;
  pair: string;
  studentIds: [string, string];
  blockedStudentId: string;
  matchedStudentId: string;
  decision: TwinDecision;
  previous: TwinDecision | null;
  reviewerScope: "institution" | "class_teacher" | "department";
  departmentId: string | null;
}

/** Writes one decision. Ids, the decision and who made it — never a face or a score. */
export async function recordDecision(input: RecordDecisionInput, client: Client = prisma): Promise<void> {
  await recordAuditLog(
    {
      action: input.decision === "confirmed" ? TWIN_CONFIRMED_ACTION : TWIN_REJECTED_ACTION,
      entityType: PAIR_ENTITY_TYPE,
      entityId: input.pair,
      institutionId: input.institutionId,
      actorUserId: input.actorUserId,
      beforeJson: { decision: input.previous },
      afterJson: {
        decision: input.decision,
        studentIds: input.studentIds,
        blockedStudentId: input.blockedStudentId,
        matchedStudentId: input.matchedStudentId,
        reviewerScope: input.reviewerScope,
        ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      },
    },
    client,
  );
}

export interface RecordDeclarationInput {
  institutionId: string;
  actorUserId: string;
  pair: string;
  studentIds: [string, string];
  /** The row this one stands in front of: none, or a withdrawn declaration. */
  previous: "withdrawn" | null;
  reviewerScope: "institution" | "class_teacher" | "department";
  departmentId: string | null;
}

/**
 * Writes one declaration: staff know these two are different people who look
 * alike. The confirmation the enrollment check already reads, marked as
 * declared in advance. Ids and who — never a face or a score.
 */
export async function recordDeclaration(input: RecordDeclarationInput, client: Client = prisma): Promise<void> {
  await recordAuditLog(
    {
      action: TWIN_CONFIRMED_ACTION,
      entityType: PAIR_ENTITY_TYPE,
      entityId: input.pair,
      institutionId: input.institutionId,
      actorUserId: input.actorUserId,
      beforeJson: { decision: input.previous },
      afterJson: {
        decision: "confirmed",
        source: "declared",
        relationship: "known_twin_lookalike",
        studentIds: input.studentIds,
        reviewerScope: input.reviewerScope,
        ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      },
    },
    client,
  );
}

export interface RecordWithdrawalInput {
  institutionId: string;
  actorUserId: string;
  pair: string;
  studentIds: [string, string];
  reviewerScope: "institution" | "class_teacher" | "department";
  departmentId: string | null;
}

/** Writes the removal of a declaration: the pair has no decision again. */
export async function recordWithdrawal(input: RecordWithdrawalInput, client: Client = prisma): Promise<void> {
  await recordAuditLog(
    {
      action: TWIN_WITHDRAWN_ACTION,
      entityType: PAIR_ENTITY_TYPE,
      entityId: input.pair,
      institutionId: input.institutionId,
      actorUserId: input.actorUserId,
      beforeJson: { decision: "confirmed", source: "declared" },
      afterJson: {
        decision: "withdrawn",
        studentIds: input.studentIds,
        reviewerScope: input.reviewerScope,
        ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      },
    },
    client,
  );
}

/**
 * Runs `fn` holding this pair's lock, in one transaction: two people
 * declaring the same pair at once — either way round, since the key is
 * sorted — read and write one after the other, so the second finds the first
 * one's row and writes nothing.
 */
export async function withPairLock<T>(
  institutionId: string,
  pair: string,
  fn: (client: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`twin-pair:${institutionId}:${pair}`}))`;
    return fn(tx);
  });
}

/** Every student on roll here — the pool a declaration's two students come from. */
export async function onRollStudentIds(institutionId: string, client: Client = prisma): Promise<string[]> {
  const rows = await client.student.findMany({
    where: { institutionId, status: "ACTIVE" },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** Names, codes and current classes, for the declaration picker. Institution-scoped. */
export async function studentOptions(
  institutionId: string,
  studentIds: readonly string[],
  client: Client = prisma,
): Promise<TwinStudentOption[]> {
  if (studentIds.length === 0) return [];
  const rows = await client.student.findMany({
    where: { institutionId, status: "ACTIVE", id: { in: [...studentIds] } },
    select: {
      id: true,
      studentCode: true,
      firstName: true,
      lastName: true,
      enrollments: {
        where: { status: "ACTIVE" },
        select: { cohort: { select: { name: true, termLabel: true } } },
        orderBy: { enrolledAt: "desc" },
      },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  return rows.map((row) => ({
    studentId: row.id,
    studentCode: row.studentCode,
    firstName: row.firstName,
    lastName: row.lastName,
    classes: row.enrollments.map((link) =>
      link.cohort.termLabel ? `${link.cohort.name} · ${link.cohort.termLabel}` : link.cohort.name,
    ),
  }));
}

/**
 * Of these students, the ones in this class for recognition's purposes: on
 * roll, an ACTIVE enrollment in it, same institution throughout — the
 * candidate loaders' own rule (modules/recognition-results/eligibility.ts),
 * whether or not they have a face enrolled.
 */
export async function studentsOnRollInClass(
  institutionId: string,
  cohortId: string,
  studentIds: readonly string[],
  client: Client = prisma,
): Promise<Set<string>> {
  if (studentIds.length === 0) return new Set();
  const rows = await client.enrollment.findMany({
    where: {
      institutionId,
      cohortId,
      status: "ACTIVE",
      studentId: { in: [...studentIds] },
      student: { institutionId, status: "ACTIVE" },
      cohort: { institutionId },
    },
    distinct: ["studentId"],
    select: { studentId: true },
  });
  return new Set(rows.map((row) => row.studentId));
}

/**
 * These students, as a reviewer sees them: name, code, whether on roll, the
 * classes or sections they are in now, and how many face samples are in use.
 * Institution-scoped; an id from elsewhere is simply absent.
 */
export async function studentSummaries(
  institutionId: string,
  studentIds: readonly string[],
  client: Client = prisma,
): Promise<Map<string, TwinStudentSummary>> {
  if (studentIds.length === 0) return new Map();
  const rows = await client.student.findMany({
    where: { institutionId, id: { in: [...studentIds] } },
    select: {
      id: true,
      studentCode: true,
      firstName: true,
      lastName: true,
      status: true,
      enrollments: {
        where: { status: "ACTIVE" },
        select: { cohort: { select: { name: true, termLabel: true } } },
        orderBy: { enrolledAt: "desc" },
      },
      faceEmbeddings: {
        where: { isActive: true },
        select: { createdAt: true },
      },
    },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      {
        studentId: row.id,
        studentCode: row.studentCode,
        firstName: row.firstName,
        lastName: row.lastName,
        onRoll: row.status === "ACTIVE",
        classes: row.enrollments.map((link) =>
          link.cohort.termLabel ? `${link.cohort.name} · ${link.cohort.termLabel}` : link.cohort.name,
        ),
        activeFaceSamples: row.faceEmbeddings.length,
        lastFaceEnrolledAt: row.faceEmbeddings.reduce<Date | null>(
          (latest, sample) => (latest === null || sample.createdAt > latest ? sample.createdAt : latest),
          null,
        ),
      } satisfies TwinStudentSummary,
    ]),
  );
}

/**
 * Of these students, the ones in a current class — a class in an academic
 * year that is not archived — whose class teacher (the class's primary
 * teacher) is this user.
 */
export async function studentsInClassesTaughtBy(
  institutionId: string,
  userId: string,
  studentIds: readonly string[],
  client: Client = prisma,
): Promise<Set<string>> {
  if (studentIds.length === 0) return new Set();
  const rows = await client.enrollment.findMany({
    where: {
      studentId: { in: [...studentIds] },
      status: "ACTIVE",
      cohort: {
        institutionId,
        academicSession: { isActive: true },
        facultyLinks: { some: { userId, role: "PRIMARY" } },
      },
    },
    distinct: ["studentId"],
    select: { studentId: true },
  });
  return new Set(rows.map((row) => row.studentId));
}

/** Whether this user is the class teacher of any current class here. */
export async function isClassTeacherAnywhere(
  institutionId: string,
  userId: string,
  client: Client = prisma,
): Promise<boolean> {
  const row = await client.cohortFaculty.findFirst({
    where: { userId, role: "PRIMARY", cohort: { institutionId, academicSession: { isActive: true } } },
    select: { id: true },
  });
  return row !== null;
}

/** Display names for the people who decided, by user id. Institution-scoped. */
export async function userNames(
  institutionId: string,
  userIds: readonly string[],
  client: Client = prisma,
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await client.user.findMany({
    where: { id: { in: ids }, institutionId },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

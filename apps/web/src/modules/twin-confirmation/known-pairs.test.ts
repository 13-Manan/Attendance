import { test } from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_ROLES, type PermissionKey } from "../authorization/permissions.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import { declaredPairs, foldPairs, pairKey } from "./policy.ts";
import type { RecordDeclarationInput, RecordWithdrawalInput } from "./repository.ts";
import {
  declareKnownTwinPair,
  knownTwinPairsInClass,
  knownTwinsOfStudent,
  listKnownTwinPairs,
  withdrawKnownTwinPair,
  type TwinConfirmationDeps,
} from "./service.ts";
import { TwinConfirmationError, type DecisionEvent, type TwinStudentSummary } from "./types.ts";

/**
 * Known twins and lookalikes marked in advance — who may, which students, and
 * that a pair is one record however it is asked for. No database: the same
 * school and college as service.test.ts.
 *
 * The school: 7A (class teacher Asha) with Riya and Diya, who are twins; 7B
 * (class teacher Ben) with Kabir. Farah teaches 7A as its primary teacher but
 * holds the plain FACULTY role. Old Omar is off roll. The college: Computer
 * Science (head Hari) with Aman and Arun; Mechanical (head Lena) with Meera.
 */

function actor(userId: string, roleKey: string, institutionId: string, permissions?: PermissionKey[]): SessionUser {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === roleKey);
  return {
    userId,
    email: `${userId}@test.local`,
    name: userId,
    institutionId,
    campusId: null,
    roles: [
      {
        key: roleKey,
        name: role?.name ?? roleKey,
        institutionId,
        campusId: null,
        permissions: permissions ?? ([...(role?.permissions ?? [])] as PermissionKey[]),
      },
    ],
  };
}

const SCHOOL = "school";
const COLLEGE = "college";
const principal = actor("principal", "SCHOOL_ADMIN", SCHOOL);
const asha = actor("asha", "CLASS_TEACHER", SCHOOL);
const ben = actor("ben", "CLASS_TEACHER", SCHOOL);
const farah = actor("farah", "FACULTY", SCHOOL);
const otto = actor("otto", "ATTENDANCE_OPERATOR", SCHOOL);
const riyaUser = actor("riya-user", "STUDENT", SCHOOL);
const deskWithTwins = actor("desk-1", "RECEPTIONIST__desk-1", SCHOOL, ["student.read", "cohort.read", "twinConfirmation.decide"]);
const deskWithout = actor("desk-2", "RECEPTIONIST__desk-2", SCHOOL, ["student.read", "cohort.read", "faceEmbedding.enroll"]);
const director = actor("director", "COLLEGE_ADMIN", COLLEGE);
const hari = actor("hari", "HOD", COLLEGE);
const lena = actor("lena", "HOD", COLLEGE);
const dina = actor("dina", "DEPARTMENT_FACULTY", COLLEGE);

const at = (minute: number) => new Date(Date.UTC(2026, 9, 3, 9, minute));

function summary(studentId: string, firstName: string, code: string, extra: Partial<TwinStudentSummary> = {}): TwinStudentSummary {
  return {
    studentId,
    studentCode: code,
    firstName,
    lastName: "Test",
    onRoll: true,
    classes: [],
    activeFaceSamples: 0,
    lastFaceEnrolledAt: null,
    ...extra,
  };
}

interface Harness {
  deps: TwinConfirmationDeps;
  decisions: DecisionEvent[];
  declared: RecordDeclarationInput[];
  withdrawn: RecordWithdrawalInput[];
}

function harness(options: { decisions?: DecisionEvent[]; classOf?: Record<string, string> } = {}): Harness {
  const students = new Map<string, { institutionId: string; summary: TwinStudentSummary }>([
    ["riya", { institutionId: SCHOOL, summary: summary("riya", "Riya", "7A-01", { classes: ["7A"] }) }],
    ["diya", { institutionId: SCHOOL, summary: summary("diya", "Diya", "7A-02", { classes: ["7A"], activeFaceSamples: 5 }) }],
    ["kabir", { institutionId: SCHOOL, summary: summary("kabir", "Kabir", "7B-01", { classes: ["7B"] }) }],
    ["omar", { institutionId: SCHOOL, summary: summary("omar", "Omar", "7A-09", { classes: [], onRoll: false }) }],
    ["aman", { institutionId: COLLEGE, summary: summary("aman", "Aman", "CSE01", { classes: ["CSE101-A"] }) }],
    ["arun", { institutionId: COLLEGE, summary: summary("arun", "Arun", "CSE02", { classes: ["CSE101-A"] }) }],
    ["meera", { institutionId: COLLEGE, summary: summary("meera", "Meera", "ME01", { classes: ["MEC101-A"] }) }],
  ]);
  const classTeacherOf = new Map<string, Set<string>>([
    ["asha", new Set(["riya", "diya", "omar"])],
    ["ben", new Set(["kabir"])],
    ["farah", new Set(["riya", "diya"])],
  ]);
  const department = new Map<string, Set<string>>([
    ["cse", new Set(["aman", "arun"])],
    ["me", new Set(["meera"])],
  ]);
  const headOf: Record<string, string> = { hari: "cse", lena: "me" };
  const classOf = options.classOf ?? { riya: "7a", diya: "7a", kabir: "7b" };

  const h: Harness = { deps: {}, decisions: [...(options.decisions ?? [])], declared: [], withdrawn: [] };
  const latest = (pair: string) =>
    h.decisions.filter((d) => d.pair === pair).sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : 1)).at(-1) ??
    null;
  h.deps = {
    getInstitutionType: async (id) => (id === SCHOOL ? "SCHOOL" : id === COLLEGE ? "COLLEGE" : null),
    listConflicts: async () => [],
    listDecisions: async (_institutionId, opts = {}) => h.decisions.filter((d) => !opts.pairs || opts.pairs.includes(d.pair)),
    studentSummaries: async (institutionId, ids) =>
      new Map(
        ids
          .map((id) => students.get(id))
          .filter((row): row is { institutionId: string; summary: TwinStudentSummary } => row?.institutionId === institutionId)
          .map((row) => [row.summary.studentId, row.summary]),
      ),
    studentsInClassesTaughtBy: async (_institutionId, userId, ids) => new Set(ids.filter((id) => classTeacherOf.get(userId)?.has(id))),
    isClassTeacherAnywhere: async (_institutionId, userId) => classTeacherOf.has(userId),
    userNames: async (_institutionId, ids) => new Map(ids.map((id) => [id, `Name of ${id}`])),
    departmentStudentsAmong: async (who, departmentId, ids) => {
      const isAdmin = who.roles.some((role) => role.permissions.includes("academicStructure.manage"));
      if (!isAdmin && headOf[who.userId] !== departmentId) throw new ForbiddenError("not_department_head");
      const members = department.get(departmentId) ?? new Set<string>();
      return {
        scope: { kind: isAdmin ? "admin" : "hod" },
        department: { id: departmentId, name: departmentId.toUpperCase() },
        studentIds: new Set(ids.filter((id) => members.has(id))),
      };
    },
    standingDecision: async (_institutionId, pair) => latest(pair),
    recordDeclaration: async (input) => {
      h.declared.push(input);
      h.decisions.push({ id: `x${h.decisions.length + 1}`, pair: input.pair, decision: "confirmed", source: "declared", at: at(30 + h.decisions.length), byUserId: input.actorUserId });
    },
    recordWithdrawal: async (input) => {
      h.withdrawn.push(input);
      h.decisions.push({ id: `x${h.decisions.length + 1}`, pair: input.pair, decision: "withdrawn", at: at(30 + h.decisions.length), byUserId: input.actorUserId });
    },
    withPairLock: async (_institutionId, _pair, fn) => fn(null),
    onRollStudentIds: async (institutionId) =>
      [...students.values()].filter((row) => row.institutionId === institutionId && row.summary.onRoll).map((row) => row.summary.studentId),
    studentOptions: async (institutionId, ids) =>
      ids
        .map((id) => students.get(id))
        .filter((row): row is { institutionId: string; summary: TwinStudentSummary } => row?.institutionId === institutionId)
        .map(({ summary: s }) => ({ studentId: s.studentId, studentCode: s.studentCode, firstName: s.firstName, lastName: s.lastName, classes: s.classes })),
    studentsOnRollInClass: async (_institutionId, cohortId, ids) =>
      new Set(ids.filter((id) => classOf[id] === cohortId && students.get(id)?.summary.onRoll)),
  };
  return h;
}

const RIYA_DIYA = pairKey("riya", "diya");
const NOT_DECLARABLE = /can't be marked here/;

// ---------------------------------------------------------------------------
// The pure rules
// ---------------------------------------------------------------------------

test("declaredPairs: the latest row decides — a withdrawal or a later review ends a declaration", () => {
  const pair = (a: string, b: string) => pairKey(a, b);
  const rows: DecisionEvent[] = [
    { id: "1", pair: pair("a", "b"), decision: "confirmed", source: "declared", at: at(1), byUserId: "p" },
    { id: "2", pair: pair("c", "d"), decision: "confirmed", source: "declared", at: at(1), byUserId: "p" },
    { id: "3", pair: pair("c", "d"), decision: "withdrawn", at: at(2), byUserId: "p" },
    { id: "4", pair: pair("e", "f"), decision: "confirmed", source: "declared", at: at(1), byUserId: "p" },
    { id: "5", pair: pair("e", "f"), decision: "rejected", at: at(3), byUserId: "p" },
    { id: "6", pair: pair("g", "h"), decision: "confirmed", at: at(1), byUserId: "p" },
    { id: "7", pair: pair("i", "j"), decision: "withdrawn", at: at(1), byUserId: "p" },
    { id: "8", pair: pair("i", "j"), decision: "confirmed", source: "declared", at: at(4), byUserId: "p" },
  ];
  assert.deepEqual([...declaredPairs(rows).keys()].sort(), [pair("a", "b"), pair("i", "j")]);
});

test("foldPairs: a conflict whose declaration was withdrawn is pending again; one still declared is confirmed", () => {
  const conflicts = [
    { id: "c1", blockedStudentId: "b", matchedStudentId: "a", at: at(1), channel: "SELF" as const },
    { id: "c2", blockedStudentId: "d", matchedStudentId: "c", at: at(1), channel: "STAFF" as const },
  ];
  const decisions: DecisionEvent[] = [
    { id: "1", pair: pairKey("a", "b"), decision: "confirmed", source: "declared", at: at(2), byUserId: "p" },
    { id: "2", pair: pairKey("a", "b"), decision: "withdrawn", at: at(3), byUserId: "p" },
    { id: "3", pair: pairKey("c", "d"), decision: "confirmed", source: "declared", at: at(2), byUserId: "p" },
  ];
  const folded = new Map(foldPairs(conflicts, decisions).map((p) => [p.pair, p]));
  assert.equal(folded.get(pairKey("a", "b"))?.state, "pending");
  assert.equal(folded.get(pairKey("a", "b"))?.decision, null);
  assert.equal(folded.get(pairKey("c", "d"))?.state, "confirmed");
});

// ---------------------------------------------------------------------------
// Who may declare — school
// ---------------------------------------------------------------------------

test("the principal declares any pair in the school; either order is the same pair", async () => {
  const h = harness();
  const first = await declareKnownTwinPair(principal, { studentIds: ["riya", "diya"] }, {}, h.deps);
  assert.equal(first.changed, true);
  assert.deepEqual(first.students.map((s) => s.studentId), ["diya", "riya"], "ordered as the key is");
  const cross = await declareKnownTwinPair(principal, { studentIds: ["kabir", "riya"] }, {}, h.deps);
  assert.equal(cross.changed, true, "a pair across two classes is the principal's");
  assert.deepEqual(h.declared.map((d) => [d.pair, d.reviewerScope, d.studentIds]), [
    [RIYA_DIYA, "institution", ["diya", "riya"]],
    [pairKey("kabir", "riya"), "institution", ["kabir", "riya"]],
  ]);
});

test("a class teacher declares a pair inside their class, and nothing across classes", async () => {
  const h = harness();
  assert.equal((await declareKnownTwinPair(asha, { studentIds: ["diya", "riya"] }, {}, h.deps)).changed, true);
  assert.equal(h.declared[0].reviewerScope, "class_teacher");
  await assert.rejects(declareKnownTwinPair(asha, { studentIds: ["riya", "kabir"] }, {}, h.deps), NOT_DECLARABLE);
  await assert.rejects(declareKnownTwinPair(ben, { studentIds: ["riya", "kabir"] }, {}, h.deps), NOT_DECLARABLE);
  assert.equal(h.declared.length, 1, "nothing written for the refusals");
});

test("a plain teacher, an attendance operator and a student can never declare", async () => {
  const h = harness();
  for (const who of [farah, otto, riyaUser]) {
    await assert.rejects(declareKnownTwinPair(who, { studentIds: ["riya", "diya"] }, {}, h.deps), ForbiddenError, who.userId);
  }
  assert.equal(h.declared.length, 0);
});

test("a receptionist declares only when the principal switched twin decisions on", async () => {
  const h = harness();
  await assert.rejects(declareKnownTwinPair(deskWithout, { studentIds: ["riya", "diya"] }, {}, h.deps), ForbiddenError);
  assert.equal(h.declared.length, 0, "enrolling faces does not imply it");
  assert.equal((await declareKnownTwinPair(deskWithTwins, { studentIds: ["riya", "diya"] }, {}, h.deps)).changed, true);
});

test("unknown, other-institution and off-roll students — and the same student twice — are refused alike", async () => {
  const h = harness();
  for (const ids of [["riya", "ghost"], ["riya", "aman"], ["riya", "omar"]]) {
    await assert.rejects(declareKnownTwinPair(principal, { studentIds: ids }, {}, h.deps), NOT_DECLARABLE, ids.join("+"));
  }
  // The class teacher of an off-roll student gets the same sentence: nothing says which one failed.
  await assert.rejects(declareKnownTwinPair(asha, { studentIds: ["riya", "omar"] }, {}, h.deps), NOT_DECLARABLE);
  await assert.rejects(declareKnownTwinPair(principal, { studentIds: ["riya", "riya"] }, {}, h.deps), /two different students/);
  await assert.rejects(declareKnownTwinPair(principal, { studentIds: ["riya"] }, {}, h.deps), /Choose two students/);
  await assert.rejects(declareKnownTwinPair(principal, { studentIds: ["riya", "di~ya"] }, {}, h.deps), NOT_DECLARABLE);
  await assert.rejects(declareKnownTwinPair(principal, { studentIds: "riya,diya" }, {}, h.deps), /Choose two students/);
  assert.equal(h.declared.length, 0);
});

// ---------------------------------------------------------------------------
// Who may declare — college
// ---------------------------------------------------------------------------

test("a head of department declares within their department, from its page; another department's pair is refused", async () => {
  const h = harness();
  const ok = await declareKnownTwinPair(hari, { studentIds: ["aman", "arun"] }, { departmentId: "cse" }, h.deps);
  assert.equal(ok.changed, true);
  assert.deepEqual([h.declared[0].reviewerScope, h.declared[0].departmentId], ["department", "cse"]);
  await assert.rejects(declareKnownTwinPair(hari, { studentIds: ["aman", "meera"] }, { departmentId: "cse" }, h.deps), NOT_DECLARABLE);
  await assert.rejects(declareKnownTwinPair(lena, { studentIds: ["aman", "arun"] }, { departmentId: "cse" }, h.deps), ForbiddenError);
  // Without a department, an HOD is not an institution-wide reviewer.
  await assert.rejects(declareKnownTwinPair(hari, { studentIds: ["aman", "arun"] }, {}, h.deps), ForbiddenError);
  await assert.rejects(declareKnownTwinPair(dina, { studentIds: ["aman", "arun"] }, { departmentId: "cse" }, h.deps), ForbiddenError);
});

test("the director declares any pair in the college, across departments", async () => {
  const h = harness();
  assert.equal((await declareKnownTwinPair(director, { studentIds: ["aman", "meera"] }, {}, h.deps)).changed, true);
  assert.equal(h.declared[0].reviewerScope, "institution");
});

// ---------------------------------------------------------------------------
// One pair, one state
// ---------------------------------------------------------------------------

test("declaring a declared pair writes nothing and says so — whichever way round", async () => {
  const h = harness();
  await declareKnownTwinPair(principal, { studentIds: ["riya", "diya"] }, {}, h.deps);
  const again = await declareKnownTwinPair(asha, { studentIds: ["diya", "riya"] }, {}, h.deps);
  assert.deepEqual([again.changed, again.source], [false, "declared"]);
  assert.equal(h.declared.length, 1);
});

test("a pair already confirmed in a review stays that one confirmation", async () => {
  const h = harness({ decisions: [{ id: "r1", pair: RIYA_DIYA, decision: "confirmed", at: at(1), byUserId: "asha" }] });
  const result = await declareKnownTwinPair(principal, { studentIds: ["riya", "diya"] }, {}, h.deps);
  assert.deepEqual([result.changed, result.source], [false, "review"]);
  assert.equal(h.declared.length, 0);
});

test("a pair a review recorded as not confirmed is not turned into known twins here", async () => {
  const h = harness({ decisions: [{ id: "r1", pair: RIYA_DIYA, decision: "rejected", at: at(1), byUserId: "asha" }] });
  await assert.rejects(declareKnownTwinPair(principal, { studentIds: ["riya", "diya"] }, {}, h.deps), /not confirmed/);
  assert.equal(h.declared.length, 0);
});

test("removing: a declaration is withdrawn once; a review's decision is not removable here", async () => {
  const h = harness();
  await declareKnownTwinPair(principal, { studentIds: ["riya", "diya"] }, {}, h.deps);
  assert.deepEqual(await withdrawKnownTwinPair(asha, { pair: RIYA_DIYA }, {}, h.deps), { changed: true });
  assert.deepEqual(await withdrawKnownTwinPair(asha, { pair: RIYA_DIYA }, {}, h.deps), { changed: false });
  assert.equal(h.withdrawn.length, 1);

  const reviewed = harness({ decisions: [{ id: "r1", pair: RIYA_DIYA, decision: "confirmed", at: at(1), byUserId: "asha" }] });
  await assert.rejects(withdrawKnownTwinPair(principal, { pair: RIYA_DIYA }, {}, reviewed.deps), /decided in a review/);
  assert.equal(reviewed.withdrawn.length, 0);

  // Same authority rules as declaring.
  await assert.rejects(withdrawKnownTwinPair(farah, { pair: RIYA_DIYA }, {}, h.deps), ForbiddenError);
  await assert.rejects(withdrawKnownTwinPair(ben, { pair: RIYA_DIYA }, {}, h.deps), NOT_DECLARABLE);
  await assert.rejects(withdrawKnownTwinPair(principal, { pair: "diya~riya~x" }, {}, h.deps), NOT_DECLARABLE);
});

test("after a withdrawal the pair can be declared again, and the row says what it follows", async () => {
  const h = harness();
  await declareKnownTwinPair(principal, { studentIds: ["riya", "diya"] }, {}, h.deps);
  await withdrawKnownTwinPair(principal, { pair: RIYA_DIYA }, {}, h.deps);
  const again = await declareKnownTwinPair(principal, { studentIds: ["riya", "diya"] }, {}, h.deps);
  assert.equal(again.changed, true);
  assert.deepEqual(h.declared.map((d) => d.previous), [null, "withdrawn"]);
});

// ---------------------------------------------------------------------------
// What each reader sees
// ---------------------------------------------------------------------------

test("the list: declared pairs in the reviewer's scope, both on roll; the picker offers the reviewer's own students", async () => {
  const h = harness();
  await declareKnownTwinPair(principal, { studentIds: ["riya", "diya"] }, {}, h.deps);
  await declareKnownTwinPair(principal, { studentIds: ["riya", "kabir"] }, {}, h.deps);

  const all = await listKnownTwinPairs(principal, {}, h.deps);
  assert.equal(all.pairs.length, 2);
  assert.deepEqual(all.students.map((s) => s.studentId).sort(), ["diya", "kabir", "riya"], "on roll only");

  const mine = await listKnownTwinPairs(asha, {}, h.deps);
  assert.deepEqual(mine.pairs.map((p) => p.pair), [RIYA_DIYA], "the cross-class pair is the principal's");
  assert.deepEqual(mine.students.map((s) => s.studentId).sort(), ["diya", "riya"]);
  assert.equal(mine.pairs[0].declaredByName, "Name of principal");

  await assert.rejects(listKnownTwinPairs(farah, {}, h.deps), ForbiddenError);
});

test("a student's record: their declared pairs for someone who manages them; no panel for anyone else", async () => {
  const h = harness();
  await declareKnownTwinPair(principal, { studentIds: ["riya", "diya"] }, {}, h.deps);
  await declareKnownTwinPair(principal, { studentIds: ["riya", "kabir"] }, {}, h.deps);

  const forPrincipal = await knownTwinsOfStudent(principal, "riya", {}, h.deps);
  assert.deepEqual(forPrincipal?.pairs.map((p) => p.other.studentId).sort(), ["diya", "kabir"]);
  assert.equal(forPrincipal?.canDeclare, true);

  const forAsha = await knownTwinsOfStudent(asha, "riya", {}, h.deps);
  assert.deepEqual(forAsha?.pairs.map((p) => p.other.studentId), ["diya"], "only pairs inside her classes");

  assert.equal(await knownTwinsOfStudent(ben, "riya", {}, h.deps), null, "not his student");
  assert.equal(await knownTwinsOfStudent(farah, "riya", {}, h.deps), null, "not a reviewer");
  assert.equal(await knownTwinsOfStudent(riyaUser, "riya", {}, h.deps), null, "never the student");
  assert.equal(await knownTwinsOfStudent(principal, "aman", {}, h.deps), null, "another institution");
});

test("recognition's read: declared pairs with both students on roll in the class — nothing else", async () => {
  const h = harness({
    decisions: [
      { id: "r1", pair: pairKey("kabir", "riya"), decision: "confirmed", at: at(1), byUserId: "principal" },
      { id: "r2", pair: pairKey("diya", "kabir"), decision: "rejected", at: at(1), byUserId: "principal" },
    ],
  });
  await declareKnownTwinPair(principal, { studentIds: ["riya", "diya"] }, {}, h.deps);
  assert.deepEqual(await knownTwinPairsInClass(SCHOOL, "7a", h.deps), [["diya", "riya"]]);
  assert.deepEqual(await knownTwinPairsInClass(SCHOOL, "7b", h.deps), [], "a twin in another class cannot be in this photograph");

  await withdrawKnownTwinPair(principal, { pair: RIYA_DIYA }, {}, h.deps);
  assert.deepEqual(await knownTwinPairsInClass(SCHOOL, "7a", h.deps), [], "withdrawn: back to the faces alone");

  // Reviews — confirmed or not — are not declarations: recognition is as it always was for them.
  const reviewedOnly = harness({ decisions: [{ id: "r1", pair: RIYA_DIYA, decision: "confirmed", at: at(1), byUserId: "asha" }] });
  assert.deepEqual(await knownTwinPairsInClass(SCHOOL, "7a", reviewedOnly.deps), []);
});

test("errors carry no student detail: the refusal is a sentence, not an id", async () => {
  const h = harness();
  const error = await declareKnownTwinPair(principal, { studentIds: ["riya", "aman"] }, {}, h.deps).catch((e: unknown) => e);
  assert.ok(error instanceof TwinConfirmationError);
  assert.doesNotMatch((error as Error).message, /aman|riya|CSE|7A/);
});

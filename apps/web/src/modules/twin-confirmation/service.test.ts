import { test } from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_ROLES, type PermissionKey } from "../authorization/permissions.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import { pairKey } from "./policy.ts";
import type { RecordDecisionInput } from "./repository.ts";
import {
  canReviewTwinConfirmations,
  decideTwinConfirmation,
  getTwinConfirmation,
  listTwinConfirmations,
  twinBlockStates,
  type TwinConfirmationDeps,
} from "./service.ts";
import { TwinConfirmationError, type ConflictEvent, type DecisionEvent, type TwinStudentSummary } from "./types.ts";

/**
 * Who may see and decide a twin / lookalike pair — without a database.
 *
 * The school has two classes: 7A (class teacher Asha, a CLASS_TEACHER) with
 * Riya and Diya, who are twins, and 7B (class teacher Ben) with Kabir. Farah
 * teaches 7A as its primary teacher but holds the plain FACULTY role. The
 * college has Computer Science (head: Hari) with Aman and Arun, and
 * Mechanical with Meera.
 */

function actor(userId: string, roleKey: string, institutionId: string): SessionUser {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === roleKey)!;
  return {
    userId,
    email: `${userId}@test.local`,
    name: userId,
    institutionId,
    campusId: null,
    roles: [{ key: roleKey, name: role.name, institutionId, campusId: null, permissions: [...role.permissions] as PermissionKey[] }],
  };
}

const SCHOOL = "school";
const COLLEGE = "college";
const principal = actor("principal", "SCHOOL_ADMIN", SCHOOL);
const asha = actor("asha", "CLASS_TEACHER", SCHOOL);
const ben = actor("ben", "CLASS_TEACHER", SCHOOL);
const farah = actor("farah", "FACULTY", SCHOOL);
const riyaUser = actor("riya-user", "STUDENT", SCHOOL);
const director = actor("director", "COLLEGE_ADMIN", COLLEGE);
const hari = actor("hari", "HOD", COLLEGE);
const lena = actor("lena", "HOD", COLLEGE);
const collegeTeacher = actor("teach", "CLASS_TEACHER", COLLEGE);
const dina = actor("dina", "DEPARTMENT_FACULTY", COLLEGE);
const schoolOperator = actor("otto", "ATTENDANCE_OPERATOR", SCHOOL);
const collegeOperator = actor("olga", "ATTENDANCE_OPERATOR", COLLEGE);

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 9, minute));

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
  recorded: RecordDecisionInput[];
  decisions: DecisionEvent[];
}

function harness(options: { conflicts?: ConflictEvent[]; offRoll?: string[] } = {}): Harness {
  const students = new Map<string, { institutionId: string; summary: TwinStudentSummary }>([
    ["riya", { institutionId: SCHOOL, summary: summary("riya", "Riya", "7A-01", { classes: ["7A"] }) }],
    ["diya", { institutionId: SCHOOL, summary: summary("diya", "Diya", "7A-02", { classes: ["7A"], activeFaceSamples: 5 }) }],
    ["kabir", { institutionId: SCHOOL, summary: summary("kabir", "Kabir", "7B-01", { classes: ["7B"], activeFaceSamples: 5 }) }],
    ["aman", { institutionId: COLLEGE, summary: summary("aman", "Aman", "CSE01", { classes: ["CSE101-A"] }) }],
    ["arun", { institutionId: COLLEGE, summary: summary("arun", "Arun", "CSE02", { classes: ["CSE101-A"], activeFaceSamples: 5 }) }],
    ["meera", { institutionId: COLLEGE, summary: summary("meera", "Meera", "ME01", { classes: ["MEC101-A"], activeFaceSamples: 5 }) }],
  ]);
  for (const id of options.offRoll ?? []) students.get(id)!.summary.onRoll = false;

  const classTeacherOf = new Map<string, Set<string>>([
    ["asha", new Set(["riya", "diya"])],
    ["ben", new Set(["kabir"])],
    ["farah", new Set(["riya", "diya"])],
  ]);
  const department = new Map<string, Set<string>>([
    ["cse", new Set(["aman", "arun"])],
    ["me", new Set(["meera"])],
  ]);
  const headOf: Record<string, string> = { hari: "cse", lena: "me" };

  const conflicts = options.conflicts ?? [
    { id: "c1", blockedStudentId: "riya", matchedStudentId: "diya", at: at(1), channel: "SELF" },
    { id: "c2", blockedStudentId: "riya", matchedStudentId: "kabir", at: at(2), channel: "SELF" },
    { id: "c3", blockedStudentId: "aman", matchedStudentId: "arun", at: at(3), channel: "SELF" },
    { id: "c4", blockedStudentId: "aman", matchedStudentId: "meera", at: at(4), channel: "STAFF" },
  ];
  const h: Harness = { deps: {}, recorded: [], decisions: [] };
  h.deps = {
    getInstitutionType: async (id) => (id === SCHOOL ? "SCHOOL" : id === COLLEGE ? "COLLEGE" : null),
    listConflicts: async (institutionId, opts = {}) =>
      conflicts.filter(
        (c) =>
          students.get(c.blockedStudentId)?.institutionId === institutionId &&
          (!opts.blockedStudentIds || opts.blockedStudentIds.includes(c.blockedStudentId)),
      ),
    listDecisions: async (institutionId, opts = {}) =>
      h.decisions.filter((d) => !opts.pairs || opts.pairs.includes(d.pair)),
    studentSummaries: async (institutionId, ids) =>
      new Map(
        ids
          .map((id) => students.get(id))
          .filter((row): row is { institutionId: string; summary: TwinStudentSummary } => row?.institutionId === institutionId)
          .map((row) => [row.summary.studentId, row.summary]),
      ),
    studentsInClassesTaughtBy: async (_institutionId, userId, ids) =>
      new Set(ids.filter((id) => classTeacherOf.get(userId)?.has(id))),
    isClassTeacherAnywhere: async (_institutionId, userId) => classTeacherOf.has(userId),
    userNames: async (_institutionId, ids) => new Map(ids.map((id) => [id, `Name of ${id}`])),
    recordDecision: async (input) => {
      h.recorded.push(input);
      h.decisions.push({ id: `d${h.decisions.length + 1}`, pair: input.pair, decision: input.decision, at: at(30 + h.decisions.length), byUserId: input.actorUserId });
    },
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
  };
  return h;
}

const pairs = (list: { pending: Array<{ pair: string }>; decided: Array<{ pair: string }> }) =>
  [...list.pending, ...list.decided].map((item) => item.pair).sort();

// ---------------------------------------------------------------------------
// School
// ---------------------------------------------------------------------------

test("9. the principal sees and decides every pair in the school", async () => {
  const h = harness();
  const list = await listTwinConfirmations(principal, {}, h.deps);
  assert.deepEqual(pairs(list), [pairKey("riya", "diya"), pairKey("riya", "kabir")]);
  assert.equal(list.reviewer.kind, "institution");

  const done = await decideTwinConfirmation(principal, { pair: pairKey("riya", "kabir"), decision: "confirmed" }, {}, h.deps);
  assert.deepEqual(done, { state: "confirmed", changed: true });
  assert.deepEqual(
    [h.recorded[0].reviewerScope, h.recorded[0].studentIds, h.recorded[0].blockedStudentId, h.recorded[0].matchedStudentId, h.recorded[0].previous],
    ["institution", ["kabir", "riya"], "riya", "kabir", null],
  );
});

test("8. a class teacher sees and decides only pairs inside their own classes", async () => {
  const h = harness();
  const list = await listTwinConfirmations(asha, {}, h.deps);
  assert.equal(list.reviewer.kind, "class_teacher");
  assert.deepEqual(pairs(list), [pairKey("riya", "diya")], "Riya and Kabir are in different classes");

  await decideTwinConfirmation(asha, { pair: pairKey("riya", "diya"), decision: "confirmed" }, {}, h.deps);
  assert.equal(h.recorded[0].reviewerScope, "class_teacher");

  await assert.rejects(
    () => decideTwinConfirmation(asha, { pair: pairKey("riya", "kabir"), decision: "confirmed" }, {}, h.deps),
    TwinConfirmationError,
    "a pair across two classes is the principal's",
  );
  await assert.rejects(() => getTwinConfirmation(ben, pairKey("riya", "diya"), {}, h.deps), TwinConfirmationError);
  assert.equal(h.recorded.length, 1);
});

test("7. a teacher who is a class's primary teacher but not a Class Teacher cannot confirm anything", async () => {
  const h = harness();
  assert.equal(await canReviewTwinConfirmations(farah, {}, h.deps), false);
  await assert.rejects(() => listTwinConfirmations(farah, {}, h.deps), ForbiddenError);
  await assert.rejects(
    () => decideTwinConfirmation(farah, { pair: pairKey("riya", "diya"), decision: "confirmed" }, {}, h.deps),
    ForbiddenError,
  );
  assert.equal(h.recorded.length, 0);
});

test("3/4/5. a student cannot open, list or decide a confirmation — not even their own pair", async () => {
  const h = harness();
  assert.equal(await canReviewTwinConfirmations(riyaUser, {}, h.deps), false);
  await assert.rejects(() => listTwinConfirmations(riyaUser, {}, h.deps), ForbiddenError);
  await assert.rejects(() => getTwinConfirmation(riyaUser, pairKey("riya", "diya"), {}, h.deps), ForbiddenError);
  for (const decision of ["confirmed", "rejected"] as const) {
    await assert.rejects(
      () => decideTwinConfirmation(riyaUser, { pair: pairKey("riya", "diya"), decision }, {}, h.deps),
      ForbiddenError,
    );
  }
  // Nor through a department's page of some college.
  await assert.rejects(
    () => decideTwinConfirmation(riyaUser, { pair: pairKey("riya", "diya"), decision: "confirmed" }, { departmentId: "cse" }, h.deps),
    ForbiddenError,
  );
  assert.equal(h.recorded.length, 0);
});

test("6. 4. 21. forged or edited pair keys are refused before anything is decided", async () => {
  const h = harness();
  // `riya~diya` is the real pair written backwards: a key this app never writes.
  for (const pair of ["riya~diya", "riya~riya", "riya", "riya~diya~kabir", "riya~nobody", pairKey("diya", "kabir"), "", "../x~y"]) {
    await assert.rejects(
      () => decideTwinConfirmation(principal, { pair, decision: "confirmed" }, {}, h.deps),
      TwinConfirmationError,
      pair,
    );
  }
  await assert.rejects(
    () => decideTwinConfirmation(principal, { pair: pairKey("riya", "diya"), decision: "approve" as never }, {}, h.deps),
    TwinConfirmationError,
  );
  assert.equal(h.recorded.length, 0, "a pair that never collided cannot be confirmed into existence");
});

test("a decision is changed by deciding again; deciding the same thing twice writes nothing", async () => {
  const h = harness();
  const pair = pairKey("riya", "diya");
  await decideTwinConfirmation(principal, { pair, decision: "confirmed" }, {}, h.deps);
  assert.deepEqual(await decideTwinConfirmation(principal, { pair, decision: "confirmed" }, {}, h.deps), {
    state: "confirmed",
    changed: false,
  });
  await decideTwinConfirmation(asha, { pair, decision: "rejected" }, {}, h.deps);
  assert.deepEqual(h.recorded.map((r) => [r.decision, r.previous]), [["confirmed", null], ["rejected", "confirmed"]]);
  const detail = await getTwinConfirmation(principal, pair, {}, h.deps);
  assert.equal(detail.item.state, "rejected");
  assert.equal(detail.item.decidedByName, "Name of asha");
  assert.deepEqual(detail.history.map((entry) => entry.kind), ["rejected", "confirmed", "conflict"]);
});

test("16. a student taken off roll leaves the queue, and their pair cannot be decided", async () => {
  const h = harness({ offRoll: ["diya"] });
  assert.deepEqual(pairs(await listTwinConfirmations(principal, {}, h.deps)), [pairKey("riya", "kabir")]);
  await assert.rejects(
    () => decideTwinConfirmation(principal, { pair: pairKey("riya", "diya"), decision: "confirmed" }, {}, h.deps),
    TwinConfirmationError,
  );
});

test("a school student's own block state names nobody", async () => {
  const h = harness();
  await decideTwinConfirmation(principal, { pair: pairKey("riya", "diya"), decision: "confirmed" }, {}, h.deps);
  const states = await twinBlockStates(SCHOOL, ["riya", "diya", "kabir"], h.deps);
  assert.deepEqual([...states.entries()], [["riya", "pending"]], "Riya is still waiting on the Kabir pair");
});

// ---------------------------------------------------------------------------
// College
// ---------------------------------------------------------------------------

test("10. a head of department decides pairs inside their department, and nothing outside it", async () => {
  const h = harness();
  const list = await listTwinConfirmations(hari, { departmentId: "cse" }, h.deps);
  assert.equal(list.reviewer.kind, "department");
  assert.deepEqual(pairs(list), [pairKey("aman", "arun")], "Aman and Meera cross departments");

  await decideTwinConfirmation(hari, { pair: pairKey("aman", "arun"), decision: "confirmed" }, { departmentId: "cse" }, h.deps);
  assert.deepEqual([h.recorded[0].reviewerScope, h.recorded[0].departmentId], ["department", "cse"]);

  await assert.rejects(
    () => decideTwinConfirmation(hari, { pair: pairKey("aman", "meera"), decision: "confirmed" }, { departmentId: "cse" }, h.deps),
    TwinConfirmationError,
  );
  await assert.rejects(
    () => listTwinConfirmations(hari, { departmentId: "me" }, h.deps),
    ForbiddenError,
    "another department's page",
  );
  // A head holds no institution-wide face permission.
  await assert.rejects(() => listTwinConfirmations(hari, {}, h.deps), ForbiddenError);
  assert.equal(h.recorded.length, 1);
});

test("11. the director decides any pair in the college, across departments", async () => {
  const h = harness();
  assert.deepEqual(pairs(await listTwinConfirmations(director, {}, h.deps)), [pairKey("aman", "arun"), pairKey("aman", "meera")]);
  await decideTwinConfirmation(director, { pair: pairKey("aman", "meera"), decision: "rejected" }, {}, h.deps);
  assert.equal(h.recorded[0].reviewerScope, "institution");
  // And sees a department's own pairs from its page.
  assert.deepEqual(pairs(await listTwinConfirmations(director, { departmentId: "me" }, h.deps)), []);
});

test("a college has no class teachers for this: confirmation is the HOD's or the director's", async () => {
  const h = harness();
  await assert.rejects(() => listTwinConfirmations(collegeTeacher, {}, h.deps), ForbiddenError);
  await assert.rejects(() => listTwinConfirmations(lena, { departmentId: "cse" }, h.deps), ForbiddenError);
});

test("7. department faculty and attendance operators cannot open or decide a confirmation, from any page", async () => {
  const h = harness();
  const cases = [
    [schoolOperator, pairKey("riya", "diya"), {}],
    [collegeOperator, pairKey("aman", "arun"), {}],
    [collegeOperator, pairKey("aman", "arun"), { departmentId: "cse" }],
    [dina, pairKey("aman", "arun"), {}],
    [dina, pairKey("aman", "arun"), { departmentId: "cse" }],
  ] as const;
  for (const [who, pair, context] of cases) {
    assert.equal(await canReviewTwinConfirmations(who, context, h.deps), false, who.userId);
    await assert.rejects(() => listTwinConfirmations(who, context, h.deps), ForbiddenError);
    await assert.rejects(() => getTwinConfirmation(who, pair, context, h.deps), ForbiddenError);
    await assert.rejects(() => decideTwinConfirmation(who, { pair, decision: "confirmed" }, context, h.deps), ForbiddenError);
  }
  assert.equal(h.recorded.length, 0);
});

test("the queue carries names, codes, classes and counts — never a score or a face", async () => {
  const h = harness();
  const text = JSON.stringify(await listTwinConfirmations(principal, {}, h.deps));
  assert.equal(/similarity|embedding|vector|imageBase64/i.test(text), false);
});

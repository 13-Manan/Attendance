import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignStudentToClassForRequest,
  createStudentForRequest,
  getStudentForRequest,
  getStudentFormOptionsForRequest,
  listStudentsForRequest,
  removeStudentFromClassForRequest,
  setStudentStatusForRequest,
  updateStudentForRequest,
  type StudentDirectoryDeps,
  type StudentInput,
} from "./directory-service.ts";
import { StudentError, type StudentDetail } from "./directory-types.ts";
import { EMPTY_STUDENT_FILTERS } from "./directory-filters.ts";
import type { Student } from "./types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Enrollment } from "@prisma/client";

/**
 * Administering students: who may do what, whose institution it lands in, and
 * what is refused before anything is written.
 *
 * Everything is injected, so none of this needs a database. The assertions
 * that matter are the negative ones — that a student id arriving from a URL
 * cannot reach another tenant's row, that a refusal happens before the write
 * rather than after it, and that a message never confirms the existence of
 * something in another institution.
 */

type Permissions = SessionUser["roles"][number]["permissions"];

const ALL_STUDENT_PERMISSIONS = [
  "student.read",
  "student.create",
  "student.update",
  "enrollment.manage",
];

function makeUser(
  overrides: { permissions?: string[]; institutionId?: string | null } = {},
): SessionUser {
  return {
    userId: "user-admin",
    email: "admin@example.edu",
    name: "Admin",
    institutionId: overrides.institutionId === undefined ? "inst-A" : overrides.institutionId,
    campusId: null,
    roles: [
      {
        key: "INSTITUTION_ADMIN",
        name: "Institution Admin",
        institutionId: "inst-A",
        campusId: null,
        permissions: (overrides.permissions ?? ALL_STUDENT_PERMISSIONS) as Permissions,
      },
    ],
  };
}

const ADMIN = makeUser();

function makeDetail(overrides: Partial<StudentDetail> = {}): StudentDetail {
  return {
    id: "student-1",
    studentCode: "S-014",
    firstName: "Priya",
    lastName: "Sharma",
    email: null,
    phone: null,
    admissionNumber: null,
    admissionDate: null,
    status: "ACTIVE",
    campusId: null,
    campusName: null,
    classes: [],
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    allClasses: [],
    faceSampleCount: 0,
    activeFaceSampleCount: 0,
    ...overrides,
  };
}

function makeClassLink(overrides: Partial<StudentDetail["classes"][number]> = {}) {
  return {
    enrollmentId: "enr-1",
    cohortId: "cohort-1",
    cohortName: "9A",
    termLabel: null,
    academicSessionId: "year-1",
    academicSessionName: "2026-27",
    academicSessionIsCurrent: true,
    status: "ACTIVE" as const,
    enrolledAt: new Date("2026-06-01T00:00:00.000Z"),
    unenrolledAt: null,
    ...overrides,
  };
}

function makeStudent(overrides: Partial<Student> = {}): Student {
  return {
    id: "student-1",
    institutionId: "inst-A",
    studentCode: "S-014",
    firstName: "Priya",
    lastName: "Sharma",
    status: "ACTIVE",
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  } as Student;
}

type CreateInput = Parameters<NonNullable<StudentDirectoryDeps["create"]>>[1];
type UpdateInput = Parameters<NonNullable<StudentDirectoryDeps["update"]>>[1];
type Placement = { studentId: string; cohortId: string };

function spyDeps(overrides: StudentDirectoryDeps = {}) {
  const scopes: string[] = [];
  const creates: CreateInput[] = [];
  const updates: UpdateInput[] = [];
  const enrolled: Placement[] = [];
  const unenrolled: Placement[] = [];

  const deps: StudentDirectoryDeps = {
    search: async (institutionId) => {
      scopes.push(institutionId);
      return {
        rows: [],
        total: 0,
        totalAll: 0,
        activeAll: 0,
        page: 1,
        pageCount: 1,
        pageSize: 25,
      };
    },
    get: async (institutionId, id) => {
      scopes.push(institutionId);
      return institutionId === "inst-A" ? makeDetail({ id }) : null;
    },
    findByCode: async (institutionId) => {
      scopes.push(institutionId);
      return null;
    },
    listCohorts: async (institutionId) => {
      scopes.push(institutionId);
      return [];
    },
    listCampuses: async (institutionId) => {
      scopes.push(institutionId);
      return [];
    },
    findCohort: async (institutionId, cohortId) => {
      scopes.push(institutionId);
      return institutionId === "inst-A" ? { id: cohortId, name: "9A" } : null;
    },
    findCampus: async (institutionId, campusId) => {
      scopes.push(institutionId);
      return institutionId === "inst-A" ? { id: campusId, name: "Main", isActive: true } : null;
    },
    create: async (_actor, input) => {
      creates.push(input);
      return makeStudent({ institutionId: input.institutionId });
    },
    update: async (_actor, input) => {
      updates.push(input);
      return makeStudent({ id: input.studentId, status: input.status ?? "ACTIVE" });
    },
    enroll: async (_actor, input) => {
      enrolled.push(input);
      return { id: "enr-new" } as Enrollment;
    },
    unenroll: async (_actor, input) => {
      unenrolled.push(input);
      return { id: "enr-old" } as Enrollment;
    },
    now: () => new Date("2026-09-20T00:00:00.000Z"),
    ...overrides,
  };

  return { deps, scopes, creates, updates, enrolled, unenrolled };
}

const VALID: StudentInput = {
  studentCode: "S-014",
  firstName: "Priya",
  lastName: "Sharma",
  email: "",
  phone: "",
  campusId: "",
  admissionNumber: "",
  admissionDate: "",
};

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

test("no function here takes an institution id", () => {
  // The signatures are the guarantee: there is no argument through which a
  // form field or a route parameter could name another school. `Function.length`
  // stops at the first default, so `overrides` is excluded and these are
  // exactly what a caller must supply.
  assert.equal(listStudentsForRequest.length, 2, "the actor and the filters");
  assert.equal(getStudentForRequest.length, 2, "the actor and a student id");
  assert.equal(getStudentFormOptionsForRequest.length, 1, "the actor, and nothing else");
  assert.equal(createStudentForRequest.length, 2, "the actor and the form");
  assert.equal(updateStudentForRequest.length, 3, "the actor, a student id and the form");
  assert.equal(setStudentStatusForRequest.length, 3, "the actor, a student id and a status");
  assert.equal(assignStudentToClassForRequest.length, 2, "the actor and the placement");
  assert.equal(removeStudentFromClassForRequest.length, 2, "the actor and the placement");
});

test("the institution passed to every repository call comes from the session", async () => {
  const { deps, scopes } = spyDeps();
  await listStudentsForRequest(ADMIN, EMPTY_STUDENT_FILTERS, deps);
  await getStudentForRequest(ADMIN, "student-1", deps);
  await getStudentFormOptionsForRequest(ADMIN, deps);
  assert.ok(scopes.length >= 4);
  assert.deepEqual(new Set(scopes), new Set(["inst-A"]));
});

test("a student belonging to another institution reads as not existing", async () => {
  // Not "forbidden": saying which would turn the URL into an oracle for
  // guessing another institution's student ids.
  const { deps } = spyDeps({ get: async () => null });
  await assert.rejects(
    () => getStudentForRequest(ADMIN, "student-from-inst-B", deps),
    (error: unknown) =>
      error instanceof StudentError && error.message === "That student does not exist.",
  );
});

test("a platform-level account is told it has no institution rather than seeing every student", async () => {
  const platform = makeUser({ institutionId: null });
  const { deps, scopes } = spyDeps();
  await assert.rejects(
    () => listStudentsForRequest(platform, EMPTY_STUDENT_FILTERS, deps),
    StudentError,
  );
  assert.equal(scopes.length, 0, "nothing is read when there is no institution to scope to");
});

test("every entry point checks its permission before it reads or writes anything", async () => {
  const faculty = makeUser({ permissions: ["cohort.read"] });
  const { deps, scopes, creates, updates, enrolled, unenrolled } = spyDeps();

  await assert.rejects(
    () => listStudentsForRequest(faculty, EMPTY_STUDENT_FILTERS, deps),
    ForbiddenError,
  );
  await assert.rejects(() => getStudentForRequest(faculty, "student-1", deps), ForbiddenError);
  await assert.rejects(() => getStudentFormOptionsForRequest(faculty, deps), ForbiddenError);
  await assert.rejects(() => createStudentForRequest(faculty, VALID, deps), ForbiddenError);
  await assert.rejects(
    () => updateStudentForRequest(faculty, "student-1", VALID, deps),
    ForbiddenError,
  );
  await assert.rejects(
    () => setStudentStatusForRequest(faculty, "student-1", "INACTIVE", deps),
    ForbiddenError,
  );
  await assert.rejects(
    () =>
      assignStudentToClassForRequest(
        faculty,
        { studentId: "student-1", cohortId: "cohort-1" },
        deps,
      ),
    ForbiddenError,
  );
  await assert.rejects(
    () =>
      removeStudentFromClassForRequest(
        faculty,
        { studentId: "student-1", cohortId: "cohort-1" },
        deps,
      ),
    ForbiddenError,
  );

  assert.deepEqual(scopes, []);
  assert.deepEqual(creates, []);
  assert.deepEqual(updates, []);
  assert.deepEqual(enrolled, []);
  assert.deepEqual(unenrolled, []);
});

// ---------------------------------------------------------------------------
// Admitting
// ---------------------------------------------------------------------------

test("a new student is created in the session's institution", async () => {
  const { deps, creates } = spyDeps();
  await createStudentForRequest(ADMIN, VALID, deps);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].institutionId, "inst-A");
  assert.equal(creates[0].studentCode, "S-014");
  assert.equal(creates[0].email, null, "an empty box is absent, not an empty string");
  assert.equal(creates[0].campusId, null);
});

test("the form's own institution field, if one were ever added, is ignored", async () => {
  const { deps, creates } = spyDeps();
  await createStudentForRequest(
    ADMIN,
    { ...VALID, institutionId: "inst-B" } as StudentInput & { institutionId: string },
    deps,
  );
  assert.equal(creates[0].institutionId, "inst-A");
});

test("a duplicate student code is refused by name, and nothing is created", async () => {
  const { deps, creates } = spyDeps({
    findByCode: async () => ({ id: "student-9", firstName: "Rahul", lastName: "Verma" }),
  });
  await assert.rejects(
    () => createStudentForRequest(ADMIN, VALID, deps),
    (error: unknown) =>
      error instanceof StudentError &&
      error.message.includes("Rahul Verma") &&
      error.message.includes("S-014"),
  );
  assert.deepEqual(creates, [], "the clash is caught before the write");
});

test("placing a student at admission needs the placement permission, checked first", async () => {
  // An administrator who cannot place students should be told so, not have a
  // student created and the placement silently dropped.
  const clerk = makeUser({ permissions: ["student.create", "student.read"] });
  const { deps, creates, enrolled, scopes } = spyDeps();
  await assert.rejects(
    () => createStudentForRequest(clerk, { ...VALID, cohortId: "cohort-1" }, deps),
    ForbiddenError,
  );
  assert.deepEqual(creates, []);
  assert.deepEqual(enrolled, []);
  assert.deepEqual(scopes, [], "nothing is even read");
});

test("a class from another institution is refused before the student is created", async () => {
  const { deps, creates, enrolled } = spyDeps({ findCohort: async () => null });
  await assert.rejects(
    () => createStudentForRequest(ADMIN, { ...VALID, cohortId: "cohort-inst-B" }, deps),
    (error: unknown) =>
      error instanceof StudentError && error.message === "That class does not exist.",
  );
  assert.deepEqual(creates, [], "no half-admitted student with an error saying nothing happened");
  assert.deepEqual(enrolled, []);
});

test("an admitted student with a class is created and then placed", async () => {
  const { deps, creates, enrolled } = spyDeps();
  await createStudentForRequest(ADMIN, { ...VALID, cohortId: "cohort-1" }, deps);
  assert.equal(creates.length, 1);
  assert.deepEqual(enrolled, [{ studentId: "student-1", cohortId: "cohort-1" }]);
});

test("a campus that is not this institution's is refused", async () => {
  const { deps, creates } = spyDeps({ findCampus: async () => null });
  await assert.rejects(
    () => createStudentForRequest(ADMIN, { ...VALID, campusId: "campus-inst-B" }, deps),
    (error: unknown) =>
      error instanceof StudentError && error.message === "That campus does not exist.",
  );
  assert.deepEqual(creates, []);
});

test("a closed campus is still allowed", async () => {
  // A branch that shut last year still has students whose records need
  // correcting.
  const { deps, creates } = spyDeps({
    findCampus: async (_institutionId, campusId) => ({
      id: campusId,
      name: "Old wing",
      isActive: false,
    }),
  });
  await createStudentForRequest(ADMIN, { ...VALID, campusId: "campus-closed" }, deps);
  assert.equal(creates[0].campusId, "campus-closed");
});

test("an invalid form is refused before anything is read or written", async () => {
  const { deps, creates, scopes } = spyDeps();
  await assert.rejects(
    () => createStudentForRequest(ADMIN, { ...VALID, firstName: "  " }, deps),
    StudentError,
  );
  await assert.rejects(
    () => createStudentForRequest(ADMIN, { ...VALID, admissionDate: "2026-02-31" }, deps),
    StudentError,
  );
  assert.deepEqual(creates, []);
  assert.deepEqual(scopes, []);
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

test("editing a student from another institution is “does not exist”, and writes nothing", async () => {
  const { deps, updates } = spyDeps({ get: async () => null });
  await assert.rejects(
    () => updateStudentForRequest(ADMIN, "student-inst-B", VALID, deps),
    (error: unknown) =>
      error instanceof StudentError && error.message === "That student does not exist.",
  );
  assert.deepEqual(updates, []);
});

test("an edit that does not change the code does not go looking for a clash", async () => {
  let codeLookups = 0;
  const { deps, updates } = spyDeps({
    findByCode: async () => {
      codeLookups += 1;
      return null;
    },
  });
  await updateStudentForRequest(ADMIN, "student-1", VALID, deps);
  assert.equal(codeLookups, 0);
  assert.equal(updates[0].studentId, "student-1");
});

test("taking another student's code is refused; keeping your own is not", async () => {
  const { deps, updates } = spyDeps({
    findByCode: async () => ({ id: "student-9", firstName: "Rahul", lastName: "Verma" }),
  });
  await assert.rejects(
    () => updateStudentForRequest(ADMIN, "student-1", { ...VALID, studentCode: "S-099" }, deps),
    (error: unknown) => error instanceof StudentError && error.message.includes("Rahul Verma"),
  );
  assert.deepEqual(updates, []);

  const own = spyDeps({
    findByCode: async () => ({ id: "student-1", firstName: "Priya", lastName: "Sharma" }),
  });
  await updateStudentForRequest(ADMIN, "student-1", { ...VALID, studentCode: "S-099" }, own.deps);
  assert.equal(own.updates[0].studentCode, "S-099");
});

test("an edit that does not mention the status keeps the one the student has", async () => {
  // The edit form for an archived student must not quietly restore them.
  const { deps, updates } = spyDeps({
    get: async (_institutionId, id) => makeDetail({ id, status: "TRANSFERRED" }),
  });
  await updateStudentForRequest(ADMIN, "student-1", VALID, deps);
  assert.equal(updates[0].status, "TRANSFERRED");
});

test("a status typed into the form has to be one of the four", async () => {
  const { deps, updates } = spyDeps();
  await assert.rejects(
    () => updateStudentForRequest(ADMIN, "student-1", { ...VALID, status: "EXPELLED" }, deps),
    StudentError,
  );
  assert.deepEqual(updates, []);
});

// ---------------------------------------------------------------------------
// Taking off roll
// ---------------------------------------------------------------------------

test("archiving writes only the status, so nothing else can be changed through it", async () => {
  const { deps, updates } = spyDeps();
  await setStudentStatusForRequest(ADMIN, "student-1", "TRANSFERRED", deps);
  assert.deepEqual(updates, [{ studentId: "student-1", status: "TRANSFERRED" }]);
});

test("setting the status a student already has is refused rather than written twice", async () => {
  // A double-submitted button is harmless; a second audit row saying a child
  // left on a day they did not is not.
  const { deps, updates } = spyDeps();
  await assert.rejects(
    () => setStudentStatusForRequest(ADMIN, "student-1", "ACTIVE", deps),
    (error: unknown) => error instanceof StudentError && error.message.includes("already"),
  );
  assert.deepEqual(updates, []);
});

test("a student who left can be brought back", async () => {
  const { deps, updates } = spyDeps({
    get: async (_institutionId, id) => makeDetail({ id, status: "INACTIVE" }),
  });
  await setStudentStatusForRequest(ADMIN, "student-1", "ACTIVE", deps);
  assert.deepEqual(updates, [{ studentId: "student-1", status: "ACTIVE" }]);
});

test("a status change for another institution's student writes nothing", async () => {
  const { deps, updates } = spyDeps({ get: async () => null });
  await assert.rejects(
    () => setStudentStatusForRequest(ADMIN, "student-inst-B", "INACTIVE", deps),
    StudentError,
  );
  assert.deepEqual(updates, []);
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

test("placing a student needs enrollment.manage, not student.update", async () => {
  const editor = makeUser({ permissions: ["student.read", "student.update"] });
  const { deps, enrolled } = spyDeps();
  await assert.rejects(
    () =>
      assignStudentToClassForRequest(
        editor,
        { studentId: "student-1", cohortId: "cohort-1" },
        deps,
      ),
    ForbiddenError,
  );
  assert.deepEqual(enrolled, []);
});

test("a class from another institution does not exist, however it is reached", async () => {
  const { deps, enrolled } = spyDeps({ findCohort: async () => null });
  for (const call of [assignStudentToClassForRequest, removeStudentFromClassForRequest]) {
    await assert.rejects(
      () => call(ADMIN, { studentId: "student-1", cohortId: "cohort-inst-B" }, deps),
      (error: unknown) =>
        error instanceof StudentError && error.message === "That class does not exist.",
    );
  }
  assert.deepEqual(enrolled, []);
});

test("placing a student in a class they are already in is refused before the write", async () => {
  const { deps, enrolled } = spyDeps({
    get: async (_institutionId, id) => makeDetail({ id, classes: [makeClassLink()] }),
  });
  await assert.rejects(
    () =>
      assignStudentToClassForRequest(ADMIN, { studentId: "student-1", cohortId: "cohort-1" }, deps),
    (error: unknown) =>
      error instanceof StudentError && error.message === "Priya Sharma is already in 9A.",
  );
  assert.deepEqual(enrolled, []);
});

test("an archived student can still be placed, because a returning student is restored and placed in one sitting", async () => {
  const { deps, enrolled } = spyDeps({
    get: async (_institutionId, id) => makeDetail({ id, status: "TRANSFERRED" }),
  });
  const result = await assignStudentToClassForRequest(
    ADMIN,
    { studentId: "student-1", cohortId: "cohort-1" },
    deps,
  );
  assert.equal(result.cohortName, "9A");
  assert.deepEqual(enrolled, [{ studentId: "student-1", cohortId: "cohort-1" }]);
});

test("the enrollment service's codes become sentences, and never confirm another school's class", async () => {
  // `cross_institution_enrollment` says the id names a real class somewhere
  // else. The person reading this screen is told the same thing they would be
  // told about an id that never existed.
  const { deps } = spyDeps({
    enroll: async () => {
      throw new Error("cross_institution_enrollment");
    },
  });
  await assert.rejects(
    () =>
      assignStudentToClassForRequest(ADMIN, { studentId: "student-1", cohortId: "cohort-1" }, deps),
    (error: unknown) =>
      error instanceof StudentError &&
      error.message === "That class does not exist." &&
      !error.message.includes("cross_institution"),
  );
});

test("an unexpected failure is not dressed up as a refusal", async () => {
  const { deps } = spyDeps({
    enroll: async () => {
      throw new Error("connection terminated unexpectedly");
    },
  });
  await assert.rejects(
    () =>
      assignStudentToClassForRequest(ADMIN, { studentId: "student-1", cohortId: "cohort-1" }, deps),
    (error: unknown) => error instanceof Error && !(error instanceof StudentError),
  );
});

test("removing a student from a class names the class it happened in", async () => {
  const { deps, unenrolled } = spyDeps();
  const result = await removeStudentFromClassForRequest(
    ADMIN,
    { studentId: "student-1", cohortId: "cohort-1" },
    deps,
  );
  assert.equal(result.cohortName, "9A");
  assert.deepEqual(unenrolled, [{ studentId: "student-1", cohortId: "cohort-1" }]);
});

test("removing a placement that is not there is a sentence, not a stack trace", async () => {
  const { deps } = spyDeps({
    unenroll: async () => {
      throw new Error("enrollment_not_found");
    },
  });
  await assert.rejects(
    () =>
      removeStudentFromClassForRequest(
        ADMIN,
        { studentId: "student-1", cohortId: "cohort-1" },
        deps,
      ),
    (error: unknown) =>
      error instanceof StudentError && error.message === "That student is not in that class.",
  );
});

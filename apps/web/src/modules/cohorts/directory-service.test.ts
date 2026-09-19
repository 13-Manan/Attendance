import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachSubjectForRequest,
  createCohortFromFormForRequest,
  getCohortDetailForRequest,
  getCohortFormOptionsForRequest,
  listCohortsForRequest,
  updateCohortFromFormForRequest,
  type CohortDirectoryDeps,
  type CohortInput,
} from "./directory-service.ts";
import { CohortError, type CohortDetail } from "./directory-types.ts";
import { EMPTY_COHORT_FILTERS } from "./directory-filters.ts";
import type { Cohort } from "./types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { CohortSubject } from "@prisma/client";

/**
 * Administering classes: who may do what, whose institution it lands in, and
 * what is refused before anything is written.
 *
 * Everything is injected, so none of this needs a database. The assertions that
 * matter are the negative ones — that a cohort id arriving from a URL cannot
 * reach another tenant's class and, with it, another tenant's roster; that a
 * refusal happens before the write rather than after it; and that no message
 * ever confirms that a row exists in another institution.
 */

type Permissions = SessionUser["roles"][number]["permissions"];

const ALL_COHORT_PERMISSIONS = ["cohort.read", "cohort.manage", "academicStructure.manage"];

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
        permissions: (overrides.permissions ?? ALL_COHORT_PERMISSIONS) as Permissions,
      },
    ],
  };
}

const ADMIN = makeUser();

function makeDetail(overrides: Partial<CohortDetail> = {}): CohortDetail {
  return {
    id: "cohort-1",
    name: "8-A",
    termLabel: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    academicUnitId: "unit-1",
    academicUnitName: "Grade 8",
    academicUnitKind: "GRADE",
    academicUnitCode: null,
    campusName: null,
    academicSessionId: "year-1",
    academicSessionName: "2026-27",
    academicSessionIsCurrent: true,
    academicSessionStartDate: new Date("2026-04-01T00:00:00.000Z"),
    studentCount: 0,
    teachers: [],
    subjectCount: 0,
    roster: [],
    pastRosterCount: 0,
    subjects: [],
    attendanceSessionCount: 0,
    ...overrides,
  };
}

function makeCohort(overrides: Partial<Cohort> = {}): Cohort {
  return {
    id: "cohort-1",
    institutionId: "inst-A",
    academicUnitId: "unit-1",
    academicSessionId: "year-1",
    name: "8-A",
    termLabel: null,
    ...overrides,
  } as Cohort;
}

type CreateInput = Parameters<NonNullable<CohortDirectoryDeps["create"]>>[1];
type UpdateInput = Parameters<NonNullable<CohortDirectoryDeps["update"]>>[1];
type AttachInput = Parameters<NonNullable<CohortDirectoryDeps["attachSubject"]>>[1];

function spyDeps(overrides: CohortDirectoryDeps = {}) {
  const scopes: string[] = [];
  const creates: CreateInput[] = [];
  const updates: UpdateInput[] = [];
  const attaches: AttachInput[] = [];

  const deps: CohortDirectoryDeps = {
    search: async (institutionId) => {
      scopes.push(institutionId);
      return {
        rows: [],
        total: 0,
        totalAll: 0,
        currentYearAll: 0,
        page: 1,
        pageCount: 1,
        pageSize: 25,
      };
    },
    get: async (institutionId, id) => {
      scopes.push(institutionId);
      return institutionId === "inst-A" ? makeDetail({ id }) : null;
    },
    listUnits: async (institutionId) => {
      scopes.push(institutionId);
      return [];
    },
    listSessions: async (institutionId) => {
      scopes.push(institutionId);
      return [];
    },
    listStaff: async (institutionId) => {
      scopes.push(institutionId);
      return [];
    },
    listSubjects: async (institutionId) => {
      scopes.push(institutionId);
      return [];
    },
    institutionType: async (institutionId) => {
      scopes.push(institutionId);
      return "SCHOOL";
    },
    create: async (_actor, input) => {
      creates.push(input);
      return makeCohort({ institutionId: input.institutionId, name: input.name });
    },
    update: async (_actor, input) => {
      updates.push(input);
      return makeCohort({ id: input.cohortId, name: input.name ?? "8-A" });
    },
    attachSubject: async (_actor, input) => {
      attaches.push(input);
      return { id: "cohort-subject-1" } as CohortSubject;
    },
    ...overrides,
  };

  return { deps, scopes, creates, updates, attaches };
}

const VALID: CohortInput = {
  name: "8-A",
  termLabel: "",
  academicUnitId: "unit-1",
  academicSessionId: "year-1",
};

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

test("no function here takes an institution id", () => {
  // The signatures are the guarantee: there is no argument through which a form
  // field or a route parameter could name another institution. `Function.length`
  // stops at the first default, so `overrides` is excluded and these are exactly
  // what a caller must supply.
  assert.equal(listCohortsForRequest.length, 2, "the actor and the filters");
  assert.equal(getCohortDetailForRequest.length, 2, "the actor and a cohort id");
  assert.equal(getCohortFormOptionsForRequest.length, 1, "the actor, and nothing else");
  assert.equal(createCohortFromFormForRequest.length, 2, "the actor and the form");
  assert.equal(updateCohortFromFormForRequest.length, 3, "the actor, a cohort id and the form");
  assert.equal(attachSubjectForRequest.length, 2, "the actor and the offering");
});

test("the institution passed to every repository call comes from the session", async () => {
  const { deps, scopes } = spyDeps();
  await listCohortsForRequest(ADMIN, EMPTY_COHORT_FILTERS, deps);
  await getCohortDetailForRequest(ADMIN, "cohort-1", deps);
  await getCohortFormOptionsForRequest(ADMIN, deps);
  assert.ok(scopes.length >= 5);
  assert.deepEqual(new Set(scopes), new Set(["inst-A"]));
});

test("a class belonging to another institution reads as not existing", async () => {
  // Not "forbidden": saying which would turn the URL into an oracle for
  // guessing another institution's cohort ids — and a cohort id is what a
  // roster hangs off.
  const { deps } = spyDeps({ get: async () => null });
  await assert.rejects(
    () => getCohortDetailForRequest(ADMIN, "cohort-from-inst-B", deps),
    (error: unknown) =>
      error instanceof CohortError && error.message === "That class does not exist.",
  );
});

test("renaming another institution's class is refused before it is read for writing", async () => {
  const { deps, updates } = spyDeps({ get: async () => null });
  await assert.rejects(
    () => updateCohortFromFormForRequest(ADMIN, "cohort-from-inst-B", VALID, deps),
    (error: unknown) =>
      error instanceof CohortError && error.message === "That class does not exist.",
  );
  assert.equal(updates.length, 0, "nothing is written");
});

test("attaching a subject to another institution's class is refused the same way", async () => {
  const { deps, attaches } = spyDeps({ get: async () => null });
  await assert.rejects(
    () =>
      attachSubjectForRequest(
        ADMIN,
        { cohortId: "cohort-from-inst-B", subjectId: "subject-1", facultyId: "" },
        deps,
      ),
    (error: unknown) =>
      error instanceof CohortError && error.message === "That class does not exist.",
  );
  assert.equal(attaches.length, 0);
});

test("a platform-level account is told it has no institution rather than seeing every class", async () => {
  const platform = makeUser({ institutionId: null });
  const { deps, scopes } = spyDeps();
  await assert.rejects(
    () => listCohortsForRequest(platform, EMPTY_COHORT_FILTERS, deps),
    CohortError,
  );
  assert.equal(scopes.length, 0, "nothing is read when there is no institution to scope to");
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test("every entry point checks its permission before it reads or writes anything", async () => {
  const outsider = makeUser({ permissions: ["student.read"] });
  const { deps, scopes, creates, updates, attaches } = spyDeps();

  await assert.rejects(
    () => listCohortsForRequest(outsider, EMPTY_COHORT_FILTERS, deps),
    ForbiddenError,
  );
  await assert.rejects(() => getCohortDetailForRequest(outsider, "cohort-1", deps), ForbiddenError);
  await assert.rejects(() => getCohortFormOptionsForRequest(outsider, deps), ForbiddenError);
  await assert.rejects(() => createCohortFromFormForRequest(outsider, VALID, deps), ForbiddenError);
  await assert.rejects(
    () => updateCohortFromFormForRequest(outsider, "cohort-1", VALID, deps),
    ForbiddenError,
  );
  await assert.rejects(
    () =>
      attachSubjectForRequest(
        outsider,
        { cohortId: "cohort-1", subjectId: "subject-1", facultyId: "" },
        deps,
      ),
    ForbiddenError,
  );

  assert.equal(scopes.length, 0, "nothing is read");
  assert.equal(creates.length + updates.length + attaches.length, 0, "nothing is written");
});

test("reading a class does not require permission to change one", async () => {
  const reader = makeUser({ permissions: ["cohort.read"] });
  const { deps } = spyDeps();

  await listCohortsForRequest(reader, EMPTY_COHORT_FILTERS, deps);
  await getCohortDetailForRequest(reader, "cohort-1", deps);
  await getCohortFormOptionsForRequest(reader, deps);

  await assert.rejects(() => createCohortFromFormForRequest(reader, VALID, deps), ForbiddenError);
});

test("managing classes is not permission to change what is taught", async () => {
  // Attaching a subject is `academicStructure.manage`. Somebody who may name a
  // section is not thereby somebody who may decide what it is taught.
  const manager = makeUser({ permissions: ["cohort.read", "cohort.manage"] });
  const { deps, attaches } = spyDeps();

  await createCohortFromFormForRequest(manager, VALID, deps);
  await assert.rejects(
    () =>
      attachSubjectForRequest(
        manager,
        { cohortId: "cohort-1", subjectId: "subject-1", facultyId: "" },
        deps,
      ),
    ForbiddenError,
  );
  assert.equal(attaches.length, 0);
});

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

test("a new class lands in the session's institution, not in one the form names", async () => {
  const { deps, creates } = spyDeps();
  await createCohortFromFormForRequest(
    ADMIN,
    { ...VALID, institutionId: "inst-B" } as CohortInput,
    deps,
  );
  assert.equal(creates.length, 1);
  assert.equal(creates[0].institutionId, "inst-A");
});

test("the form is validated before the service is called", async () => {
  const { deps, creates } = spyDeps();

  await assert.rejects(
    () => createCohortFromFormForRequest(ADMIN, { ...VALID, name: "   " }, deps),
    CohortError,
  );
  await assert.rejects(
    () => createCohortFromFormForRequest(ADMIN, { ...VALID, academicUnitId: "" }, deps),
    (error: unknown) =>
      error instanceof CohortError &&
      error.message === "Choose where this class sits in the structure.",
  );
  await assert.rejects(
    () => createCohortFromFormForRequest(ADMIN, { ...VALID, academicSessionId: "" }, deps),
    (error: unknown) =>
      error instanceof CohortError &&
      error.message === "Choose the academic year this class belongs to.",
  );

  assert.equal(creates.length, 0);
});

test("an empty term is stored as null rather than as a term with no name", async () => {
  const { deps, creates } = spyDeps();
  await createCohortFromFormForRequest(ADMIN, { ...VALID, termLabel: "  " }, deps);
  await createCohortFromFormForRequest(ADMIN, { ...VALID, termLabel: " Term 1 " }, deps);
  assert.equal(creates[0].termLabel, null, "an empty box means the class runs all year");
  assert.equal(creates[1].termLabel, "Term 1");
});

// ---------------------------------------------------------------------------
// Coded errors become sentences
// ---------------------------------------------------------------------------

test("a unit from another institution is 'does not exist', not 'belongs to somebody else'", async () => {
  // The cohort service signals `cross_institution_academic_unit`. Repeating
  // that would confirm the id names a real row somewhere — which "does not
  // exist" does not.
  for (const code of ["academic_unit_not_found", "cross_institution_academic_unit"]) {
    const { deps } = spyDeps({
      create: async () => {
        throw new Error(code);
      },
    });
    await assert.rejects(
      () => createCohortFromFormForRequest(ADMIN, VALID, deps),
      (error: unknown) =>
        error instanceof CohortError &&
        error.message === "That part of the structure does not exist.",
      code,
    );
  }
});

test("an academic year from another institution reads the same way", async () => {
  for (const code of ["academic_session_not_found", "cross_institution_academic_session"]) {
    const { deps } = spyDeps({
      create: async () => {
        throw new Error(code);
      },
    });
    await assert.rejects(
      () => createCohortFromFormForRequest(ADMIN, VALID, deps),
      (error: unknown) =>
        error instanceof CohortError && error.message === "That academic year does not exist.",
      code,
    );
  }
});

test("an unrecognised failure is re-thrown rather than dressed up as a refusal", async () => {
  // A dropped connection is not "that year does not exist". Swallowing it here
  // would turn an outage into a screen full of plausible, wrong sentences.
  const boom = new Error("connection terminated unexpectedly");
  const { deps } = spyDeps({
    create: async () => {
      throw boom;
    },
  });
  await assert.rejects(() => createCohortFromFormForRequest(ADMIN, VALID, deps), boom);
});

// ---------------------------------------------------------------------------
// Renaming
// ---------------------------------------------------------------------------

test("renaming sends only the label, never the unit or the year", async () => {
  // The unit and the year are what the class *is*: enrollments, registers and
  // face reviews already point at this row on that understanding. Moving it
  // would silently re-file a year of attendance.
  const { deps, updates } = spyDeps();
  await updateCohortFromFormForRequest(
    ADMIN,
    "cohort-1",
    { ...VALID, name: "8-B", academicUnitId: "unit-9", academicSessionId: "year-9" },
    deps,
  );
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { cohortId: "cohort-1", name: "8-B", termLabel: null });
});

test("a rename is validated before the write", async () => {
  const { deps, updates } = spyDeps();
  await assert.rejects(
    () => updateCohortFromFormForRequest(ADMIN, "cohort-1", { ...VALID, name: "" }, deps),
    CohortError,
  );
  assert.equal(updates.length, 0);
});

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

test("a subject already offered is refused by name rather than by constraint violation", async () => {
  // This is the second submission of a double-clicked form. The unique index
  // would catch it, but an administrator should read a sentence.
  const { deps, attaches } = spyDeps({
    get: async (_institutionId, id) =>
      makeDetail({
        id,
        name: "Section A",
        subjects: [
          {
            cohortSubjectId: "cs-1",
            subjectId: "subject-1",
            code: "PHY201",
            name: "Physics",
            facultyId: null,
            facultyName: null,
          },
        ],
      }),
  });

  await assert.rejects(
    () =>
      attachSubjectForRequest(
        ADMIN,
        { cohortId: "cohort-1", subjectId: "subject-1", facultyId: "" },
        deps,
      ),
    (error: unknown) =>
      error instanceof CohortError && error.message === "PHY201 is already offered to Section A.",
  );
  assert.equal(attaches.length, 0);
});

test("a cleared teacher dropdown attaches the subject with nobody teaching it", async () => {
  // Not the same as an id: "" means the timetable is not settled yet, and the
  // subject is still offered. The page says no register can be opened for it.
  const { deps, attaches } = spyDeps();
  const result = await attachSubjectForRequest(
    ADMIN,
    { cohortId: "cohort-1", subjectId: "subject-1", facultyId: "" },
    deps,
  );
  assert.equal(attaches.length, 1);
  assert.equal(attaches[0].facultyId, null);
  assert.equal(result.cohortName, "8-A");
});

test("a subject must be chosen", async () => {
  const { deps, attaches } = spyDeps();
  await assert.rejects(
    () =>
      attachSubjectForRequest(ADMIN, { cohortId: "cohort-1", subjectId: "", facultyId: "" }, deps),
    (error: unknown) => error instanceof CohortError && error.message === "Choose a subject.",
  );
  assert.equal(attaches.length, 0);
});

// ---------------------------------------------------------------------------
// Form options
// ---------------------------------------------------------------------------

test("a school is not asked for subjects it does not have", async () => {
  let subjectReads = 0;
  const { deps } = spyDeps({
    listSubjects: async () => {
      subjectReads += 1;
      return [];
    },
  });
  const options = await getCohortFormOptionsForRequest(ADMIN, deps);
  assert.equal(options.institutionType, "SCHOOL");
  assert.deepEqual(options.subjects, []);
  assert.equal(subjectReads, 0);
});

test("a college is", async () => {
  let subjectReads = 0;
  const { deps } = spyDeps({
    institutionType: async () => "COLLEGE",
    listSubjects: async () => {
      subjectReads += 1;
      return [{ id: "subject-1", code: "PHY201", name: "Physics" }];
    },
  });
  const options = await getCohortFormOptionsForRequest(ADMIN, deps);
  assert.equal(options.institutionType, "COLLEGE");
  assert.equal(options.subjects.length, 1);
  assert.equal(subjectReads, 1);
});

test("an institution that has gone missing is a refusal, not a blank form", async () => {
  const { deps } = spyDeps({ institutionType: async () => null });
  await assert.rejects(() => getCohortFormOptionsForRequest(ADMIN, deps), CohortError);
});

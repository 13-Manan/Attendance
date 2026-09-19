import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSubjectFromFormForRequest,
  getSubjectForRequest,
  listSubjectsForRequest,
  subjectsApplyForRequest,
  updateSubjectFromFormForRequest,
  type SubjectDirectoryDeps,
} from "./directory-service.ts";
import { SubjectError, type SubjectRow } from "./directory-types.ts";
import { EMPTY_SUBJECT_FILTERS } from "./directory-filters.ts";
import type { CreateSubjectInput, UpdateSubjectInput } from "./service.ts";
import type { Subject } from "./types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * Administering subjects: who may do it, whose institution it lands in, and
 * what is refused before anything is written.
 *
 * Everything is injected, so none of this needs a database. The assertions that
 * matter are the negative ones — that a subject id arriving from a URL cannot
 * reach another tenant's subject, that a refusal happens before the write, and
 * that no message confirms a row exists somewhere else.
 */

type Permissions = SessionUser["roles"][number]["permissions"];

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
        permissions: (overrides.permissions ?? ["academicStructure.manage"]) as Permissions,
      },
    ],
  };
}

const ADMIN = makeUser();

function makeRow(overrides: Partial<SubjectRow> = {}): SubjectRow {
  return {
    id: "sub-1",
    code: "PHY301",
    name: "Quantum Mechanics",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    cohortCount: 0,
    ...overrides,
  };
}

function spyDeps(overrides: SubjectDirectoryDeps = {}) {
  const scopes: string[] = [];
  const creates: CreateSubjectInput[] = [];
  const updates: UpdateSubjectInput[] = [];

  const deps: SubjectDirectoryDeps = {
    search: async (institutionId) => {
      scopes.push(institutionId);
      return {
        rows: [],
        total: 0,
        totalAll: 0,
        unusedAll: 0,
        page: 1,
        pageCount: 1,
        pageSize: 25,
      };
    },
    get: async (institutionId, id) => {
      scopes.push(institutionId);
      return institutionId === "inst-A" ? makeRow({ id }) : null;
    },
    findByCode: async (institutionId) => {
      scopes.push(institutionId);
      return null;
    },
    institutionType: async (institutionId) => {
      scopes.push(institutionId);
      return "COLLEGE";
    },
    create: async (_actor, input) => {
      creates.push(input);
      return { id: "sub-new", ...input } as unknown as Subject;
    },
    update: async (_actor, input) => {
      updates.push(input);
      return { id: input.id, code: input.code, name: input.name } as unknown as Subject;
    },
    ...overrides,
  };

  return { deps, scopes, creates, updates };
}

const VALID = { code: "PHY301", name: "Quantum Mechanics" };

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

test("no function here takes an institution id", () => {
  // The signatures are the guarantee: there is no argument through which a form
  // field or a route parameter could name another institution. `Function.length`
  // stops at the first default, so `overrides` is excluded and these are exactly
  // what a caller must supply.
  assert.equal(listSubjectsForRequest.length, 2, "the actor and the filters");
  assert.equal(getSubjectForRequest.length, 2, "the actor and a subject id");
  assert.equal(subjectsApplyForRequest.length, 1, "the actor, and nothing else");
  assert.equal(createSubjectFromFormForRequest.length, 2, "the actor and the form");
  assert.equal(updateSubjectFromFormForRequest.length, 3, "the actor, an id and the form");
});

test("every read is scoped to the institution on the session", async () => {
  const { deps, scopes } = spyDeps();

  await listSubjectsForRequest(ADMIN, EMPTY_SUBJECT_FILTERS, deps);
  await getSubjectForRequest(ADMIN, "sub-1", deps);
  await subjectsApplyForRequest(ADMIN, deps);

  assert.ok(scopes.length > 0);
  assert.deepEqual([...new Set(scopes)], ["inst-A"]);
});

test("a subject id from another institution's URL reads as not existing", async () => {
  const { deps } = spyDeps({ get: async () => null });

  await assert.rejects(
    () => getSubjectForRequest(ADMIN, "sub-from-inst-B", deps),
    (error: unknown) => {
      assert.ok(error instanceof SubjectError);
      assert.match(error.message, /does not exist/);
      // Saying "that is another institution's" would confirm the id names a
      // real row somewhere else.
      assert.doesNotMatch(error.message, /another institution|permission/i);
      return true;
    },
  );
});

test("a form cannot name the institution it writes into", async () => {
  const { deps, creates } = spyDeps();

  await createSubjectFromFormForRequest(
    ADMIN,
    { ...VALID, institutionId: "inst-B" } as typeof VALID & { institutionId: string },
    deps,
  );

  assert.equal(creates[0].institutionId, "inst-A", "the session decided, not the form");
});

test("renaming reads the subject through the institution scope first", async () => {
  const { deps, updates } = spyDeps({ get: async () => null });

  await assert.rejects(
    () => updateSubjectFromFormForRequest(ADMIN, "sub-from-inst-B", VALID, deps),
    /does not exist/,
  );
  assert.equal(updates.length, 0, "nothing was written");
});

test("an account without an institution has no subjects", async () => {
  const { deps } = spyDeps();
  const platform = makeUser({ institutionId: null });

  await assert.rejects(
    () => listSubjectsForRequest(platform, EMPTY_SUBJECT_FILTERS, deps),
    SubjectError,
  );
  await assert.rejects(
    () => createSubjectFromFormForRequest(platform, VALID, deps),
    /not scoped to a single institution/,
  );
});

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

test("reading and writing both require academicStructure.manage", async () => {
  const { deps, creates } = spyDeps();
  const teacher = makeUser({ permissions: ["cohort.read", "attendance.mark"] });

  await assert.rejects(
    () => listSubjectsForRequest(teacher, EMPTY_SUBJECT_FILTERS, deps),
    ForbiddenError,
  );
  await assert.rejects(() => getSubjectForRequest(teacher, "sub-1", deps), ForbiddenError);
  await assert.rejects(() => subjectsApplyForRequest(teacher, deps), ForbiddenError);
  await assert.rejects(() => createSubjectFromFormForRequest(teacher, VALID, deps), ForbiddenError);
  await assert.rejects(
    () => updateSubjectFromFormForRequest(teacher, "sub-1", VALID, deps),
    ForbiddenError,
  );
  assert.equal(creates.length, 0);
});

test("the permission is checked before anything is read", async () => {
  let read = false;
  const { deps } = spyDeps({
    search: async () => {
      read = true;
      throw new Error("should not be reached");
    },
  });

  await assert.rejects(
    () =>
      listSubjectsForRequest(
        makeUser({ permissions: ["cohort.manage"] }),
        EMPTY_SUBJECT_FILTERS,
        deps,
      ),
    ForbiddenError,
  );
  assert.equal(read, false);
});

// ---------------------------------------------------------------------------
// The school/college distinction
// ---------------------------------------------------------------------------

test("a school is told it has no subjects rather than shown an empty list", async () => {
  const school = spyDeps({ institutionType: async () => "SCHOOL" });
  const college = spyDeps({ institutionType: async () => "COLLEGE" });

  assert.equal(await subjectsApplyForRequest(ADMIN, school.deps), false);
  assert.equal(await subjectsApplyForRequest(ADMIN, college.deps), true);
});

test("the service's college-only refusal becomes an explanation", async () => {
  // Not the administrator's mistake — the domain saying a school does not have
  // this concept.
  const { deps } = spyDeps({
    create: async () => {
      throw new Error("subjects_are_college_only");
    },
  });

  await assert.rejects(
    () => createSubjectFromFormForRequest(ADMIN, VALID, deps),
    (error: unknown) => {
      assert.ok(error instanceof SubjectError);
      assert.match(error.message, /belong to colleges/);
      assert.doesNotMatch(error.message, /subjects_are_college_only/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

test("what is created is what was validated, not what was typed", async () => {
  const { deps, creates } = spyDeps();

  await createSubjectFromFormForRequest(ADMIN, { code: "  PHY301 ", name: " Quantum  " }, deps);

  assert.equal(creates[0].code, "PHY301", "trimmed");
  assert.equal(creates[0].name, "Quantum");
});

test("a code already in use is refused, and the refusal names what has it", async () => {
  const { deps, creates } = spyDeps({
    findByCode: async () => makeRow({ id: "sub-9", code: "PHY301", name: "Physics III" }),
  });

  await assert.rejects(
    () => createSubjectFromFormForRequest(ADMIN, VALID, deps),
    /PHY301 is already used by Physics III/,
  );
  assert.equal(creates.length, 0, "refused before the write");
});

test("keeping its own code is not a clash with itself", async () => {
  const { deps, updates } = spyDeps({
    get: async (_institutionId, id) => makeRow({ id, code: "PHY301" }),
    findByCode: async () => makeRow({ id: "sub-1", code: "PHY301" }),
  });

  await updateSubjectFromFormForRequest(ADMIN, "sub-1", { ...VALID, name: "Quantum I" }, deps);

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { id: "sub-1", code: "PHY301", name: "Quantum I" });
});

test("taking another subject's code is refused", async () => {
  const { deps, updates } = spyDeps({
    get: async (_institutionId, id) => makeRow({ id, code: "PHY301" }),
    findByCode: async () => makeRow({ id: "sub-other", code: "CHE201", name: "Organic" }),
  });

  await assert.rejects(
    () => updateSubjectFromFormForRequest(ADMIN, "sub-1", { code: "CHE201", name: "X" }, deps),
    /already used by Organic/,
  );
  assert.equal(updates.length, 0);
});

test("an invalid code is refused before anything is looked up", async () => {
  let looked = false;
  const { deps, creates } = spyDeps({
    findByCode: async () => {
      looked = true;
      return null;
    },
  });

  await assert.rejects(
    () => createSubjectFromFormForRequest(ADMIN, { code: "  ", name: "Quantum" }, deps),
    /Enter a code/,
  );
  assert.equal(looked, false);
  assert.equal(creates.length, 0);
});

test("an error nobody anticipated is re-thrown rather than dressed up", async () => {
  // A dropped connection is not an administrator's mistake, and reporting it as
  // one would send somebody looking for a typo that is not there.
  const { deps } = spyDeps({
    create: async () => {
      throw new Error("connection terminated unexpectedly");
    },
  });

  await assert.rejects(
    () => createSubjectFromFormForRequest(ADMIN, VALID, deps),
    (error: unknown) => {
      assert.equal(error instanceof SubjectError, false);
      assert.match((error as Error).message, /connection terminated/);
      return true;
    },
  );
});

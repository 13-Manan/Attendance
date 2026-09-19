import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createUnitFromFormForRequest,
  getUnitForRequest,
  getUnitFormOptionsForRequest,
  listUnitsForRequest,
  updateUnitFromFormForRequest,
  type StructureDirectoryDeps,
  type UnitInput,
} from "./directory-service.ts";
import { AcademicStructureError, type UnitRow } from "./directory-types.ts";
import type { CreateAcademicUnitInput, RenameAcademicUnitInput } from "./service.ts";
import type { AcademicUnit } from "./types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Institution } from "@prisma/client";

/**
 * Administering the academic structure: who may do it, whose institution it
 * lands in, and what is refused before anything is written.
 *
 * Everything is injected, so none of this needs a database. The assertions that
 * matter are the negative ones — that a unit id arriving from a URL cannot
 * reach another tenant's department, that a refusal happens before the write
 * rather than after it, and that no message confirms a row exists somewhere
 * else.
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

function makeRow(overrides: Partial<UnitRow> = {}): UnitRow {
  return {
    id: "unit-1",
    name: "Grade 8",
    kind: "GRADE",
    code: null,
    sortOrder: 0,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    parentId: null,
    parentName: null,
    campusId: null,
    campusName: null,
    cohortCount: 0,
    childCount: 0,
    facultyCount: 0,
    ...overrides,
  };
}

function makeInstitution(type: Institution["type"] = "SCHOOL"): Institution {
  return {
    id: "inst-A",
    name: "Delhi Public School",
    type,
    settings: {},
  } as unknown as Institution;
}

function spyDeps(overrides: StructureDirectoryDeps = {}) {
  const scopes: string[] = [];
  const creates: CreateAcademicUnitInput[] = [];
  const renames: RenameAcademicUnitInput[] = [];

  const deps: StructureDirectoryDeps = {
    listRows: async (institutionId) => {
      scopes.push(institutionId);
      return [];
    },
    get: async (institutionId, id) => {
      scopes.push(institutionId);
      return institutionId === "inst-A" ? makeRow({ id }) : null;
    },
    listCampuses: async (institutionId) => {
      scopes.push(institutionId);
      return [];
    },
    getInstitution: async (institutionId) => {
      scopes.push(institutionId);
      return makeInstitution();
    },
    create: async (_actor, input) => {
      creates.push(input);
      return { id: "unit-new", ...input } as unknown as AcademicUnit;
    },
    rename: async (_actor, input) => {
      renames.push(input);
      return { id: input.id, name: input.name } as unknown as AcademicUnit;
    },
    ...overrides,
  };

  return { deps, scopes, creates, renames };
}

const VALID: UnitInput = {
  name: "Grade 8",
  code: "",
  sortOrder: "",
  kind: "GRADE",
  parentId: "",
  campusId: "",
};

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

test("no function here takes an institution id", () => {
  // The signatures are the guarantee: there is no argument through which a form
  // field or a route parameter could name another institution. `Function.length`
  // stops at the first default, so `overrides` is excluded and these are exactly
  // what a caller must supply.
  assert.equal(listUnitsForRequest.length, 1, "the actor, and nothing else");
  assert.equal(getUnitForRequest.length, 2, "the actor and a unit id");
  assert.equal(getUnitFormOptionsForRequest.length, 1, "the actor, and nothing else");
  assert.equal(createUnitFromFormForRequest.length, 2, "the actor and the form");
  assert.equal(updateUnitFromFormForRequest.length, 3, "the actor, a unit id and the form");
});

test("every read is scoped to the institution on the session", async () => {
  const { deps, scopes } = spyDeps();
  const actor = makeUser({ institutionId: "inst-A" });

  await listUnitsForRequest(actor, deps);
  await getUnitForRequest(actor, "unit-1", deps);
  await getUnitFormOptionsForRequest(actor, deps);

  assert.ok(scopes.length > 0);
  assert.deepEqual(
    [...new Set(scopes)],
    ["inst-A"],
    "nothing was read against any other institution",
  );
});

test("a unit id from another institution's URL reads as not existing", async () => {
  // The repository returns null rather than the row, and the message does not
  // distinguish "deleted" from "not yours" — saying which would turn the page
  // into an oracle for guessing ids.
  const { deps } = spyDeps({ get: async () => null });

  await assert.rejects(
    () => getUnitForRequest(ADMIN, "unit-from-inst-B", deps),
    (error: unknown) => {
      assert.ok(error instanceof AcademicStructureError);
      assert.match(error.message, /does not exist/);
      assert.doesNotMatch(error.message, /institution|permission|another/i);
      return true;
    },
  );
});

test("a form cannot name the institution it writes into", async () => {
  const { deps, creates } = spyDeps();
  const actor = makeUser({ institutionId: "inst-A" });

  await createUnitFromFormForRequest(
    actor,
    { ...VALID, institutionId: "inst-B" } as UnitInput & { institutionId: string },
    deps,
  );

  assert.equal(creates.length, 1);
  assert.equal(creates[0].institutionId, "inst-A", "the session decided, not the form");
});

test("renaming reads the unit through the institution scope first", async () => {
  const renames: RenameAcademicUnitInput[] = [];
  const { deps } = spyDeps({
    get: async () => null,
    rename: async (_actor, input) => {
      renames.push(input);
      return {} as AcademicUnit;
    },
  });

  await assert.rejects(
    () => updateUnitFromFormForRequest(ADMIN, "unit-from-inst-B", VALID, deps),
    /does not exist/,
  );
  assert.equal(renames.length, 0, "nothing was written");
});

test("an account without an institution has no structure", async () => {
  // A platform-level account is not a tenant, and defaulting it to one would
  // pick an institution at random.
  const { deps } = spyDeps();
  const platform = makeUser({ institutionId: null });

  await assert.rejects(() => listUnitsForRequest(platform, deps), AcademicStructureError);
  await assert.rejects(
    () => createUnitFromFormForRequest(platform, VALID, deps),
    /not scoped to a single institution/,
  );
});

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

test("reading and writing both require academicStructure.manage", async () => {
  const { deps, creates } = spyDeps();
  const teacher = makeUser({ permissions: ["cohort.read", "attendance.mark"] });

  await assert.rejects(() => listUnitsForRequest(teacher, deps), ForbiddenError);
  await assert.rejects(() => getUnitForRequest(teacher, "unit-1", deps), ForbiddenError);
  await assert.rejects(() => getUnitFormOptionsForRequest(teacher, deps), ForbiddenError);
  await assert.rejects(() => createUnitFromFormForRequest(teacher, VALID, deps), ForbiddenError);
  await assert.rejects(
    () => updateUnitFromFormForRequest(teacher, "unit-1", VALID, deps),
    ForbiddenError,
  );
  assert.equal(creates.length, 0);
});

test("the permission is checked before anything is read", async () => {
  let read = false;
  const { deps } = spyDeps({
    listRows: async () => {
      read = true;
      return [];
    },
  });

  await assert.rejects(
    () => listUnitsForRequest(makeUser({ permissions: ["cohort.manage"] }), deps),
    ForbiddenError,
  );
  assert.equal(read, false);
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test("the list comes back as a tree", async () => {
  const { deps } = spyDeps({
    listRows: async () => [
      makeRow({ id: "sem", name: "Semester 3", kind: "SEMESTER", parentId: "dept" }),
      makeRow({ id: "dept", name: "Computer Science", kind: "DEPARTMENT" }),
    ],
  });

  const tree = await listUnitsForRequest(ADMIN, deps);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, "dept");
  assert.equal(tree[0].children[0].id, "sem");
});

test("the form is offered only the kinds this institution type can hold", async () => {
  const school = spyDeps({ getInstitution: async () => makeInstitution("SCHOOL") });
  const college = spyDeps({ getInstitution: async () => makeInstitution("COLLEGE") });

  const schoolOptions = await getUnitFormOptionsForRequest(ADMIN, school.deps);
  const collegeOptions = await getUnitFormOptionsForRequest(ADMIN, college.deps);

  assert.equal(schoolOptions.allowedKinds.includes("SEMESTER"), false, "a school has no semesters");
  assert.ok(schoolOptions.allowedKinds.includes("GRADE"));
  assert.equal(collegeOptions.allowedKinds.includes("GRADE"), false, "a college has no grades");
  assert.ok(collegeOptions.allowedKinds.includes("DEPARTMENT"));
});

test("the form uses the institution's own word for each kind", async () => {
  const { deps } = spyDeps({
    getInstitution: async () =>
      ({
        id: "inst-A",
        name: "Test",
        type: "SCHOOL",
        settings: { academicUnitLabels: { GRADE: "Standard" } },
      }) as unknown as Institution,
  });

  const options = await getUnitFormOptionsForRequest(ADMIN, deps);

  assert.equal(options.labels.GRADE, "Standard");
});

test("every existing unit is offered as a parent, indented", async () => {
  const { deps } = spyDeps({
    listRows: async () => [
      makeRow({ id: "dept", name: "Computer Science", kind: "DEPARTMENT" }),
      makeRow({ id: "sem", name: "Semester 3", kind: "SEMESTER", parentId: "dept" }),
    ],
  });

  const options = await getUnitFormOptionsForRequest(ADMIN, deps);

  assert.deepEqual(
    options.parents.map((p) => [p.id, p.depth]),
    [
      ["dept", 0],
      ["sem", 1],
    ],
  );
});

test("an institution that has gone missing is a sentence, not a crash", async () => {
  const { deps } = spyDeps({ getInstitution: async () => null });

  await assert.rejects(() => getUnitFormOptionsForRequest(ADMIN, deps), AcademicStructureError);
  await assert.rejects(
    () => createUnitFromFormForRequest(ADMIN, VALID, deps),
    /institution does not exist/,
  );
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

test("what is created is what was validated, not what was typed", async () => {
  const { deps, creates } = spyDeps();

  await createUnitFromFormForRequest(
    ADMIN,
    { name: "  Grade 8  ", code: "  ", sortOrder: "", kind: "GRADE", parentId: "", campusId: "" },
    deps,
  );

  assert.equal(creates[0].name, "Grade 8", "trimmed");
  assert.equal(creates[0].code, null, "an empty box is not a code");
  assert.equal(creates[0].sortOrder, 0);
  assert.equal(creates[0].parentId, null, "a cleared dropdown is not an id");
  assert.equal(creates[0].campusId, null);
});

test("a kind a school cannot have is refused before the write", async () => {
  const { deps, creates } = spyDeps({
    getInstitution: async () => makeInstitution("SCHOOL"),
  });

  await assert.rejects(
    () => createUnitFromFormForRequest(ADMIN, { ...VALID, kind: "SEMESTER" }, deps),
    /structure can hold/,
  );
  assert.equal(creates.length, 0);
});

test("an invalid name is refused before the write", async () => {
  const { deps, creates } = spyDeps();

  await assert.rejects(
    () => createUnitFromFormForRequest(ADMIN, { ...VALID, name: "   " }, deps),
    /Enter a name/,
  );
  assert.equal(creates.length, 0);
});

test("the structure service's coded errors become sentences", async () => {
  const cases: [string, RegExp][] = [
    ["cross_institution_parent", /does not exist/],
    ["parent_not_found", /does not exist/],
    ["cross_institution_campus", /campus does not exist/],
    ["campus_not_found", /campus does not exist/],
    ["invalid_kind_for_institution_type:SEMESTER/SCHOOL", /structure can hold/],
  ];

  for (const [code, expected] of cases) {
    const { deps } = spyDeps({
      create: async () => {
        throw new Error(code);
      },
    });
    await assert.rejects(
      () => createUnitFromFormForRequest(ADMIN, VALID, deps),
      (error: unknown) => {
        assert.ok(error instanceof AcademicStructureError, code);
        assert.match(error.message, expected);
        // "in another institution" would confirm the id names a real row
        // somewhere else. "Does not exist" does not. Nor is the code itself
        // ever shown.
        assert.doesNotMatch(error.message, /another institution|cross_|_not_found/i);
        return true;
      },
    );
  }
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
    () => createUnitFromFormForRequest(ADMIN, VALID, deps),
    (error: unknown) => {
      assert.equal(error instanceof AcademicStructureError, false);
      assert.match((error as Error).message, /connection terminated/);
      return true;
    },
  );
});

test("renaming sends only the name, code and order", async () => {
  // Not the kind, the parent or the campus: those decide where every class
  // underneath is filed, and the attendance already taken for it.
  const { deps, renames } = spyDeps();

  await updateUnitFromFormForRequest(
    ADMIN,
    "unit-1",
    { ...VALID, name: "Grade Eight", code: "VIII", sortOrder: "3", kind: "SECTION", parentId: "elsewhere", campusId: "campus-B" },
    deps,
  );

  assert.equal(renames.length, 1);
  assert.deepEqual(renames[0], {
    id: "unit-1",
    name: "Grade Eight",
    code: "VIII",
    sortOrder: 3,
  });
});

test("a fractional order is refused rather than quietly rounded", async () => {
  const { deps, renames } = spyDeps();

  await assert.rejects(
    () => updateUnitFromFormForRequest(ADMIN, "unit-1", { ...VALID, sortOrder: "1.5" }, deps),
    /whole number/,
  );
  assert.equal(renames.length, 0);
});

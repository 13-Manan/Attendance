import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAcademicUnitTree, createAcademicUnitForRequest } from "./service.ts";
import type { AcademicUnit } from "./types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

// Pure branch of the service — no auth, just the tree shape.
test("buildAcademicUnitTree groups children under their parent", () => {
  const grade: AcademicUnit = {
    id: "g1",
    institutionId: "inst-A",
    campusId: null,
    parentId: null,
    kind: "GRADE",
    name: "Grade 10",
    code: null,
    sortOrder: 0,
    metadata: {},
    createdAt: new Date(),
  } as unknown as AcademicUnit;
  const sectionA: AcademicUnit = { ...grade, id: "s1", parentId: "g1", kind: "SECTION", name: "A" } as AcademicUnit;
  const sectionB: AcademicUnit = { ...grade, id: "s2", parentId: "g1", kind: "SECTION", name: "B" } as AcademicUnit;
  const orphan: AcademicUnit = { ...grade, id: "o1", parentId: "missing", kind: "SECTION", name: "Orphan" } as AcademicUnit;

  const tree = buildAcademicUnitTree([grade, sectionA, sectionB, orphan]);
  const gradeNode = tree.find((n) => n.id === "g1");
  assert.equal(gradeNode?.children.length, 2);
  assert.deepEqual(gradeNode?.children.map((c) => c.id).sort(), ["s1", "s2"]);
  // Orphan whose parent isn't in the input list becomes a root itself, never
  // silently dropped.
  assert.equal(tree.some((n) => n.id === "o1"), true);
});

// ---------------------------------------------------------------------------
// Creation guardrails
//
// Every one of these refusals happens before the transaction, so the denial
// paths never reach the database — which is also why they can be tested without
// one. The `parentId` and `campusId` on a new unit both arrive from a form, and
// an id belonging to another tenant would put their department or their campus
// on this institution's screens and on every register taken underneath it.
// ---------------------------------------------------------------------------

function makeActor(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    userId: "user-admin",
    email: "admin@example.edu",
    name: "Admin",
    institutionId: "inst-A",
    campusId: null,
    roles: [
      {
        key: "INSTITUTION_ADMIN",
        name: "Institution Admin",
        institutionId: "inst-A",
        campusId: null,
        permissions: ["academicStructure.manage"] as SessionUser["roles"][number]["permissions"],
      },
    ],
    ...overrides,
  };
}

const BASE_INPUT = {
  institutionId: "inst-A",
  kind: "GRADE" as const,
  name: "Grade 8",
};

test("a campus belonging to another institution is refused", async () => {
  await assert.rejects(
    () =>
      createAcademicUnitForRequest(
        makeActor(),
        { ...BASE_INPUT, campusId: "campus-from-inst-B" },
        {
          getInstitutionType: async () => "SCHOOL",
          getCampus: async () => ({ institutionId: "inst-B" }),
        },
      ),
    /cross_institution_campus/,
  );
});

test("a campus that does not exist is refused", async () => {
  await assert.rejects(
    () =>
      createAcademicUnitForRequest(
        makeActor(),
        { ...BASE_INPUT, campusId: "no-such-campus" },
        {
          getInstitutionType: async () => "SCHOOL",
          getCampus: async () => null,
        },
      ),
    /campus_not_found/,
  );
});

test("a parent belonging to another institution is refused, and the campus is never consulted", async () => {
  let campusRead = false;

  await assert.rejects(
    () =>
      createAcademicUnitForRequest(
        makeActor(),
        { ...BASE_INPUT, parentId: "unit-from-inst-B", campusId: "campus-1" },
        {
          getInstitutionType: async () => "SCHOOL",
          getParentUnit: async () =>
            ({ id: "unit-from-inst-B", institutionId: "inst-B" }) as AcademicUnit,
          getCampus: async () => {
            campusRead = true;
            return { institutionId: "inst-A" };
          },
        },
      ),
    /cross_institution_parent/,
  );
  assert.equal(campusRead, false, "it stopped at the first refusal");
});

test("a school cannot invent a semester", async () => {
  await assert.rejects(
    () =>
      createAcademicUnitForRequest(
        makeActor(),
        { ...BASE_INPUT, kind: "SEMESTER" },
        { getInstitutionType: async () => "SCHOOL" },
      ),
    /invalid_kind_for_institution_type/,
  );
});

test("creating in another institution is refused before anything is read", async () => {
  let typeRead = false;

  await assert.rejects(
    () =>
      createAcademicUnitForRequest(
        makeActor(),
        { ...BASE_INPUT, institutionId: "inst-B" },
        {
          getInstitutionType: async () => {
            typeRead = true;
            return "SCHOOL";
          },
        },
      ),
    ForbiddenError,
  );
  assert.equal(typeRead, false);
});

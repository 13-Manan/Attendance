import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classNavigationAvailable,
  findSectionForRequest,
  getStudentClassForRequest,
  getStudentClassesForRequest,
  getStudentSectionForRequest,
  listSectionStudentsForRequest,
  type ClassNavigationDeps,
} from "./class-navigation-service.ts";
import { EMPTY_STUDENT_FILTERS } from "./directory-filters.ts";
import { StudentError, type StudentPage } from "./directory-types.ts";
import type { OnRollPlacement } from "./class-navigation-repository.ts";
import type { GroupRow } from "../school-setup/repository.ts";
import type { YearChoice } from "../school-setup/types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * The class-first Students view, with every read injected: what it shows, and
 * what it refuses to show. The database-backed half — that the real queries
 * scope by institution, year and status — is
 * `class-navigation.integration.test.ts`.
 */

type Permissions = SessionUser["roles"][number]["permissions"];

function makeUser(
  overrides: { permissions?: string[]; institutionId?: string | null } = {},
): SessionUser {
  return {
    userId: "user-principal",
    email: "principal@school.test",
    name: "Principal",
    institutionId: overrides.institutionId === undefined ? "inst-A" : overrides.institutionId,
    campusId: null,
    roles: [
      {
        key: "SCHOOL_ADMIN",
        name: "School Admin",
        institutionId: "inst-A",
        campusId: null,
        permissions: (overrides.permissions ?? ["student.read", "cohort.read"]) as Permissions,
      },
    ],
  };
}

const PRINCIPAL = makeUser();

const CURRENT: YearChoice = {
  id: "year-2026",
  name: "2026-27",
  startDate: new Date("2026-04-01T00:00:00Z"),
  endDate: new Date("2027-03-31T00:00:00Z"),
  isCurrent: true,
  isActive: true,
};
const LAST: YearChoice = {
  id: "year-2025",
  name: "2025-26",
  startDate: new Date("2025-04-01T00:00:00Z"),
  endDate: new Date("2026-03-31T00:00:00Z"),
  isCurrent: false,
  isActive: true,
};

let groupClock = 0;

function group(input: {
  id: string;
  classId: string | null;
  section?: string;
  sortOrder?: number;
  yearId?: string;
  teachers?: Array<{ id: string; name: string; role: "PRIMARY" | "ASSISTANT"; active?: boolean }>;
}): GroupRow {
  const section = input.section ?? "A";
  const underClass = input.classId !== null;
  return {
    id: input.id,
    name: `${input.classId ?? "X"}-${section}`,
    createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, groupClock++)),
    academicSessionId: input.yearId ?? CURRENT.id,
    academicUnit: {
      id: `unit-${input.id}`,
      kind: underClass ? "SECTION" : "GENERIC",
      name: section,
      parentId: input.classId,
      sortOrder: input.sortOrder ?? 0,
      parent: underClass ? { id: input.classId!, kind: "GRADE" } : null,
    },
    facultyLinks: (input.teachers ?? []).map((teacher, index) => ({
      id: `link-${input.id}-${index}`,
      role: teacher.role,
      user: { id: teacher.id, name: teacher.name, status: teacher.active === false ? "INACTIVE" : "ACTIVE" },
    })),
    _count: { enrollments: 99 },
  } as GroupRow;
}

const CLASSES = [
  { id: "class-10", name: "10th" },
  { id: "class-2", name: "2nd" },
  { id: "class-1", name: "1st" },
  { id: "class-3", name: "3rd" },
];

const GROUPS = [
  group({ id: "g-2b", classId: "class-2", section: "B", sortOrder: 1, teachers: [{ id: "t-kumar", name: "Mr. Kumar", role: "PRIMARY" }] }),
  group({
    id: "g-2a",
    classId: "class-2",
    section: "A",
    sortOrder: 0,
    teachers: [
      { id: "t-helper", name: "Ms. Helper", role: "ASSISTANT" },
      { id: "t-sharma", name: "Mrs. Sharma", role: "PRIMARY" },
    ],
  }),
  group({ id: "g-2c", classId: "class-2", section: "C", sortOrder: 2, teachers: [{ id: "t-assist", name: "Mr. Only-Assistant", role: "ASSISTANT" }] }),
  group({ id: "g-10a", classId: "class-10", teachers: [{ id: "t-gone", name: "Mrs. Gone", role: "PRIMARY", active: false }] }),
  group({ id: "g-1a", classId: "class-1" }),
  group({ id: "g-loose", classId: null }),
];

const PLACEMENTS: OnRollPlacement[] = [
  { cohortId: "g-2a", studentId: "s-1" },
  { cohortId: "g-2a", studentId: "s-2" },
  { cohortId: "g-2b", studentId: "s-3" },
  // Mid-move: in two sections of one class at once — one student of the class.
  { cohortId: "g-2b", studentId: "s-1" },
  { cohortId: "g-10a", studentId: "s-4" },
];

function world(overrides: Partial<ClassNavigationDeps> = {}) {
  const calls: Record<string, unknown[][]> = {};
  const track =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      (calls[name] ??= []).push(args);
      return fn(...args);
    };
  const deps: ClassNavigationDeps = {
    institutionType: track("institutionType", async () => "SCHOOL" as const),
    listYears: track("listYears", async () => [CURRENT, LAST]),
    listClassUnits: track("listClassUnits", async () => CLASSES),
    getClassUnit: track("getClassUnit", async (_i: string, id: string) => CLASSES.find((c) => c.id === id) ?? null),
    listYearGroups: track("listYearGroups", async (_i: string, yearId: string) =>
      GROUPS.filter((g) => g.academicSessionId === yearId),
    ),
    listClassGroupsInYear: track("listClassGroupsInYear", async (_i: string, classId: string, yearId: string) =>
      GROUPS.filter((g) => g.academicSessionId === yearId && g.academicUnit.parentId === classId),
    ),
    getGroup: track("getGroup", async (_i: string, id: string) => GROUPS.find((g) => g.id === id) ?? null),
    listOnRollPlacements: track("listOnRollPlacements", async (_i: string, ids: readonly string[]) =>
      PLACEMENTS.filter((p) => ids.includes(p.cohortId)),
    ),
    ...overrides,
  };
  return { deps, calls };
}

// ---------------------------------------------------------------------------
// Who may look
// ---------------------------------------------------------------------------

test("reading students and reading classes are both required", async () => {
  const { deps } = world();
  for (const permissions of [["student.read"], ["cohort.read"], []]) {
    await assert.rejects(
      getStudentClassesForRequest(makeUser({ permissions }), undefined, deps),
      ForbiddenError,
    );
    assert.equal(await classNavigationAvailable(makeUser({ permissions }), deps), false);
  }
  assert.equal(await classNavigationAvailable(PRINCIPAL, deps), true);
});

test("an account with no institution gets no classes", async () => {
  const { deps } = world();
  await assert.rejects(
    getStudentClassesForRequest(makeUser({ institutionId: null }), undefined, deps),
    StudentError,
  );
  assert.equal(await classNavigationAvailable(makeUser({ institutionId: null }), deps), false);
});

test("the institution comes from the session, never from an argument", async () => {
  const { deps, calls } = world();
  await getStudentClassesForRequest(PRINCIPAL, undefined, deps);
  await getStudentClassForRequest(PRINCIPAL, "class-2", undefined, deps);
  await getStudentSectionForRequest(PRINCIPAL, "class-2", "g-2a", deps);
  for (const [name, list] of Object.entries(calls)) {
    for (const args of list) assert.equal(args[0], "inst-A", `${name} was scoped to ${String(args[0])}`);
  }
});

test("a college has no class-first view: its Students page stays the directory", async () => {
  const { deps } = world({ institutionType: async () => "COLLEGE" });
  assert.equal(await classNavigationAvailable(PRINCIPAL, deps), false);
  assert.equal(await getStudentClassesForRequest(PRINCIPAL, undefined, deps), null);
  assert.equal(await getStudentClassForRequest(PRINCIPAL, "class-2", undefined, deps), null);
  assert.equal(await getStudentSectionForRequest(PRINCIPAL, "class-2", "g-2a", deps), null);
});

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

test("classes are the current year's, in reading order, each with its sections and students", async () => {
  const { deps } = world();
  const view = await getStudentClassesForRequest(PRINCIPAL, undefined, deps);
  assert.ok(view);
  assert.equal(view.year?.id, CURRENT.id);
  // 3rd has no sections this year; 1st, 2nd, 10th sort as numbers.
  assert.deepEqual(view.classes.map((c) => c.name), ["1st", "2nd", "10th"]);
  const second = view.classes.find((c) => c.name === "2nd")!;
  assert.equal(second.sectionCount, 3);
  assert.equal(second.studentCount, 3, "s-1 is in two of 2nd's sections and counted once");
  assert.equal(view.classes.find((c) => c.name === "10th")!.studentCount, 1);
  assert.equal(view.otherGroups, 1, "a group not under a class is counted, not dropped");
});

test("another year is shown when asked for, and an unknown year falls back to the current one", async () => {
  const { deps, calls } = world();
  await getStudentClassesForRequest(PRINCIPAL, LAST.id, deps);
  assert.equal(calls.listYearGroups!.at(-1)![1], LAST.id);
  const fallback = await getStudentClassesForRequest(PRINCIPAL, "another-schools-year", deps);
  assert.equal(fallback?.year?.id, CURRENT.id);
});

test("no academic year: nothing to show, said as such", async () => {
  const { deps } = world({ listYears: async () => [] });
  const view = await getStudentClassesForRequest(PRINCIPAL, undefined, deps);
  assert.deepEqual(view, { year: null, years: [], classes: [], otherGroups: 0 });
});

test("the number of reads does not grow with the number of classes", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `class-${i}`, name: `${i + 1}` }));
  const groups = many.flatMap((c) =>
    ["A", "B", "C"].map((s) => group({ id: `${c.id}-${s}`, classId: c.id, section: s })),
  );
  const { deps, calls } = world({
    listClassUnits: async () => many,
    listYearGroups: async () => groups,
  });
  const view = await getStudentClassesForRequest(PRINCIPAL, undefined, deps);
  assert.equal(view?.classes.length, 30);
  assert.equal(calls.listOnRollPlacements!.length, 1, "one count query for every section");
  assert.equal(calls.listOnRollPlacements![0]![1] instanceof Array && (calls.listOnRollPlacements![0]![1] as string[]).length, 90);
});

// ---------------------------------------------------------------------------
// One class
// ---------------------------------------------------------------------------

test("a class's sections come in set-up order, with the PRIMARY teacher as class teacher", async () => {
  const { deps } = world();
  const view = await getStudentClassForRequest(PRINCIPAL, "class-2", undefined, deps);
  assert.ok(view);
  assert.deepEqual(view.sections.map((s) => s.label), ["Section A", "Section B", "Section C"]);
  const [a, b, c] = view.sections;
  assert.deepEqual(a!.classTeacher, { name: "Mrs. Sharma", active: true }, "the assistant is not the class teacher");
  assert.equal(a!.studentCount, 2);
  assert.equal(b!.classTeacher?.name, "Mr. Kumar");
  assert.equal(b!.studentCount, 2);
  assert.equal(c!.classTeacher, null, "an assistant alone is not invented into a class teacher");
  assert.equal(c!.studentCount, 0);
  assert.equal(view.studentCount, 3);
});

test("a class teacher who can no longer sign in is shown as such", async () => {
  const { deps } = world();
  const view = await getStudentClassForRequest(PRINCIPAL, "class-10", undefined, deps);
  assert.deepEqual(view?.sections[0]!.classTeacher, { name: "Mrs. Gone", active: false });
});

test("a class that is not this school's is not found", async () => {
  const { deps } = world();
  assert.equal(await getStudentClassForRequest(PRINCIPAL, "another-schools-class", undefined, deps), null);
});

test("a class with no sections this year says so rather than inventing any", async () => {
  const { deps } = world();
  const view = await getStudentClassForRequest(PRINCIPAL, "class-3", undefined, deps);
  assert.ok(view);
  assert.deepEqual(view.sections, []);
  assert.equal(view.studentCount, 0);
});

// ---------------------------------------------------------------------------
// One section
// ---------------------------------------------------------------------------

test("a section is found through its own class, with its year, teacher and count", async () => {
  const { deps } = world();
  const view = await getStudentSectionForRequest(PRINCIPAL, "class-2", "g-2a", deps);
  assert.ok(view);
  assert.equal(view.classId, "class-2");
  assert.equal(view.className, "2nd");
  assert.equal(view.year.id, CURRENT.id);
  assert.equal(view.section.label, "Section A");
  assert.equal(view.section.classTeacher?.name, "Mrs. Sharma");
  assert.equal(view.section.studentCount, 2);
});

test("a section reached through another class's URL is not that class's section", async () => {
  const { deps } = world();
  assert.equal(await getStudentSectionForRequest(PRINCIPAL, "class-10", "g-2a", deps), null);
  assert.equal(await getStudentSectionForRequest(PRINCIPAL, "class-2", "another-schools-section", deps), null);
  // A group that is not under any class is not a section here at all.
  assert.equal(await findSectionForRequest(PRINCIPAL, "g-loose", deps), null);
  assert.equal((await findSectionForRequest(PRINCIPAL, "g-2b", deps))?.classId, "class-2");
});

test("a section's students are the directory, narrowed to it, counted over it", async () => {
  const page: StudentPage = { rows: [], total: 0, totalAll: 0, activeAll: 0, page: 1, pageCount: 1, pageSize: 25 };
  const seen: unknown[][] = [];
  const deps: ClassNavigationDeps = {
    searchStudents: async (...args) => {
      seen.push(args);
      return page;
    },
  };
  await listSectionStudentsForRequest(
    PRINCIPAL,
    "g-2a",
    { ...EMPTY_STUDENT_FILTERS, q: "priya", status: "ACTIVE", cohortId: "some-other-class", sort: "code" },
    deps,
  );
  const [institutionId, filters, pageSize, scope] = seen[0]!;
  assert.equal(institutionId, "inst-A");
  assert.deepEqual(filters, {
    ...EMPTY_STUDENT_FILTERS,
    q: "priya",
    status: "ACTIVE",
    sort: "code",
    cohortId: "g-2a",
  });
  assert.equal(pageSize, 25);
  assert.deepEqual(scope, { cohortId: "g-2a" });
  await assert.rejects(
    listSectionStudentsForRequest(makeUser({ permissions: ["student.read"] }), "g-2a", EMPTY_STUDENT_FILTERS, deps),
    ForbiddenError,
  );
});

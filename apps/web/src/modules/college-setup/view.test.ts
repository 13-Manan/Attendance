import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ancestorOfKind,
  buildTree,
  courseIdOfGroup,
  courseSubjectLink,
  currentSemesterIdOf,
  departmentCourses,
  distinctStudents,
  headUserIdOf,
  sectionLabelOfGroup,
  sectionNameOfGroup,
  sectionUnitIds,
  semestersOf,
  withMetadata,
} from "./view.ts";
import type { UnitRow } from "./repository.ts";

function unit(id: string, kind: UnitRow["kind"], parentId: string | null, extra: Partial<UnitRow> = {}): UnitRow {
  return {
    id,
    kind,
    name: id,
    code: null,
    parentId,
    sortOrder: 0,
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...extra,
  };
}

const units = [
  unit("cse", "DEPARTMENT", null, { name: "Computer Science", metadata: { headUserId: "hod", currentSemesterId: "s4" } }),
  unit("me", "DEPARTMENT", null, { name: "Mechanical", metadata: { currentSemesterId: "s4" } }),
  unit("s4", "SEMESTER", "cse", { name: "4th Semester", sortOrder: 4 }),
  unit("s3", "SEMESTER", "cse", { name: "3rd Semester", sortOrder: 3 }),
  unit("phy", "COURSE", "s4", { code: "PHY401", name: "Physics" }),
  unit("che", "COURSE", "s4", { code: "CHE402", name: "Chemistry" }),
  unit("phy-a", "SECTION", "phy", { name: "A" }),
  unit("phy-b", "SECTION", "phy", { name: "B" }),
  unit("stray", "SECTION", "me", { name: "X" }),
];
const tree = buildTree(units);

test("departments are listed by name, semesters in programme order", () => {
  assert.deepEqual(tree.departments.map((d) => d.id), ["cse", "me"]);
  assert.deepEqual(semestersOf(tree, "cse").map((s) => s.id), ["s3", "s4"]);
  assert.deepEqual(departmentCourses(tree, "cse").map((c) => c.id), ["che", "phy"]);
});

test("a group belongs to a course through its section, or directly for an older one", () => {
  assert.equal(courseIdOfGroup(tree, { academicUnitId: "phy-a" }), "phy");
  assert.equal(courseIdOfGroup(tree, { academicUnitId: "phy" }), "phy");
  // A section hung off something that is not a course is not a course section.
  assert.equal(courseIdOfGroup(tree, { academicUnitId: "stray" }), null);
  assert.equal(courseIdOfGroup(tree, { academicUnitId: "unknown" }), null);
  assert.deepEqual(sectionUnitIds(tree, ["phy"]).sort(), ["phy", "phy-a", "phy-b"]);
  assert.equal(sectionNameOfGroup(tree, { academicUnitId: "phy-b", name: "PHY401-B" }), "B");
  assert.equal(sectionNameOfGroup(tree, { academicUnitId: "phy", name: "Legacy group" }), "Legacy group");
  // A screen says "Section B"; an older group keeps its own name, not "Section CSE Sem 3 - Section 1".
  assert.equal(sectionLabelOfGroup(tree, { academicUnitId: "phy-b", name: "PHY401-B" }), "Section B");
  assert.equal(sectionLabelOfGroup(tree, { academicUnitId: "phy", name: "CSE Sem 3 - Section 1" }), "CSE Sem 3 - Section 1");
});

test("ancestry walks up to the department", () => {
  assert.equal(ancestorOfKind(tree, "phy-a", "DEPARTMENT")?.id, "cse");
  assert.equal(ancestorOfKind(tree, "phy-a", "SEMESTER")?.id, "s4");
  assert.equal(ancestorOfKind(tree, "cse", "COURSE"), null);
});

test("the department's head and current semester are read from its metadata, checked against the tree", () => {
  assert.equal(headUserIdOf(tree.byId.get("cse")!), "hod");
  assert.equal(headUserIdOf(tree.byId.get("me")!), null);
  assert.equal(currentSemesterIdOf(tree, tree.byId.get("cse")!), "s4");
  // Mechanical's metadata names CSE's semester: not one of its own, so none.
  assert.equal(currentSemesterIdOf(tree, tree.byId.get("me")!), null);
});

test("metadata changes keep every other key", () => {
  const cse = tree.byId.get("cse")!;
  assert.deepEqual(withMetadata(cse, "headUserId", "someone"), { headUserId: "someone", currentSemesterId: "s4" });
  assert.deepEqual(withMetadata(cse, "headUserId", null), { currentSemesterId: "s4" });
  assert.deepEqual(withMetadata({ metadata: null }, "a", "b"), { a: "b" });
  assert.deepEqual(withMetadata({ metadata: ["not", "an", "object"] }, "a", "b"), { a: "b" });
});

test("a group's course link is the subject with the course's code, in any case", () => {
  const group = {
    subjects: [
      { id: "l1", subjectId: "s-other", facultyId: null, subject: { code: "CS302" } },
      { id: "l2", subjectId: "s-phy", facultyId: "t", subject: { code: "phy401" } },
    ],
  };
  assert.equal(courseSubjectLink(group, "PHY401")?.id, "l2");
  assert.equal(courseSubjectLink(group, "MAT403"), null);
  assert.equal(courseSubjectLink(group, null), null);
});

test("a student in several of a department's sections is counted once", () => {
  const placements = [
    { studentId: "aman", cohortId: "phy-a-2026" },
    { studentId: "aman", cohortId: "che-b-2026" },
    { studentId: "priya", cohortId: "phy-a-2026" },
    { studentId: "zoe", cohortId: "elsewhere" },
  ];
  assert.equal(distinctStudents(placements, new Set(["phy-a-2026", "che-b-2026"])), 2);
  assert.equal(distinctStudents(placements, new Set()), 0);
});

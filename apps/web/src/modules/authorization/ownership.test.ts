import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFacultyOfCohort,
  isFacultyOfCohortSubject,
  type CohortFacultyLink,
  type CohortSubjectFacultyLink,
} from "./ownership.ts";

const links: CohortFacultyLink[] = [
  { userId: "teacher-1", cohortId: "cohort-A", role: "PRIMARY" },
  { userId: "teacher-1", cohortId: "cohort-B", role: "ASSISTANT" },
  { userId: "teacher-2", cohortId: "cohort-C", role: "PRIMARY" },
];

// "Faculty only sees assigned classes/subjects."
test("faculty has access to a cohort they are linked to", () => {
  assert.equal(isFacultyOfCohort(links, "teacher-1", "cohort-A"), true);
  assert.equal(isFacultyOfCohort(links, "teacher-1", "cohort-B"), true);
});

test("faculty has no access to a cohort they are not linked to", () => {
  assert.equal(isFacultyOfCohort(links, "teacher-1", "cohort-C"), false);
});

// "Class teacher only sees permitted school class" — PRIMARY-only scoping.
test("class-teacher-only actions require the PRIMARY link, not just any link", () => {
  assert.equal(isFacultyOfCohort(links, "teacher-1", "cohort-A", { requirePrimary: true }), true);
  assert.equal(isFacultyOfCohort(links, "teacher-1", "cohort-B", { requirePrimary: true }), false);
});

test("a teacher assigned to one class cannot act as class teacher of another", () => {
  assert.equal(isFacultyOfCohort(links, "teacher-2", "cohort-A", { requirePrimary: true }), false);
});

const subjectLinks: CohortSubjectFacultyLink[] = [
  { facultyId: "faculty-1", cohortSubjectId: "subject-link-1" },
  { facultyId: "faculty-2", cohortSubjectId: "subject-link-2" },
];

test("faculty only sees the specific subject they are assigned to teach", () => {
  assert.equal(isFacultyOfCohortSubject(subjectLinks, "faculty-1", "subject-link-1"), true);
  assert.equal(isFacultyOfCohortSubject(subjectLinks, "faculty-1", "subject-link-2"), false);
});

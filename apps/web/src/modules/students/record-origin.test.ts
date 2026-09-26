import { test } from "node:test";
import assert from "node:assert/strict";
import { STUDENT_RECORD_ORIGINS, studentOriginPath } from "./record-origin.ts";

const CLASS = "cmu5dxyun000aitgu1x4tzn33";
const SECTION = "cmu5dxyup000gitgucbrqyopw";
const COHORT = "cmu5dxyuq000iitgu8zwyd8ln";
const SECTION_PATH = `/dashboard/students/classes/${CLASS}/sections/${SECTION}`;

test("a student's record can be returned from a section or a class roster, and nothing else", () => {
  assert.deepEqual(STUDENT_RECORD_ORIGINS, [
    "/dashboard/students/classes/[classId]/sections/[sectionId]",
    "/dashboard/academic/cohorts/[cohortId]",
  ]);
  assert.equal(studentOriginPath(SECTION_PATH), SECTION_PATH);
  assert.equal(
    studentOriginPath(`/dashboard/academic/cohorts/${COHORT}`),
    `/dashboard/academic/cohorts/${COHORT}`,
  );
});

test("a section's filters come back as the section page reads them", () => {
  // Known keys survive, re-serialised; a class filter is dropped (the section
  // page fixes its own class) and an unknown key is dropped.
  assert.equal(
    studentOriginPath(`${SECTION_PATH}?q=aarav&sort=code_desc&page=2&cohortId=${COHORT}&evil=1`),
    `${SECTION_PATH}?q=aarav&sort=code_desc&page=2`,
  );
  assert.equal(studentOriginPath(`${SECTION_PATH}?sort=bogus`), SECTION_PATH);
  // A roster's address takes no query at all.
  assert.equal(
    studentOriginPath(`/dashboard/academic/cohorts/${COHORT}?x=1`),
    `/dashboard/academic/cohorts/${COHORT}`,
  );
});

test("anything that is not a known list is no origin", () => {
  for (const value of [
    undefined,
    null,
    "",
    "/dashboard/students",
    "/dashboard/students?q=aarav",
    `/dashboard/students/classes/${CLASS}`,
    `/dashboard/attendance/${COHORT}`,
    `https://evil.example${SECTION_PATH}`,
    `//evil.example${SECTION_PATH}`,
    `${SECTION_PATH}#x`,
    `/dashboard/students/classes/${CLASS}/sections/..`,
  ]) {
    assert.equal(studentOriginPath(value), null, String(value));
  }
});

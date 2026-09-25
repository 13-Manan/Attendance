import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addStudentToSectionHref,
  parseSectionReturnPath,
  studentClassHref,
  studentClassesHref,
  studentSectionHref,
} from "./class-navigation-paths.ts";

test("the class-first pages have stable, deep-linkable addresses", () => {
  assert.equal(studentClassesHref(), "/dashboard/students/classes");
  assert.equal(studentClassesHref("y1"), "/dashboard/students/classes?year=y1");
  assert.equal(studentClassHref("c1"), "/dashboard/students/classes/c1");
  assert.equal(studentClassHref("c1", "y 1"), "/dashboard/students/classes/c1?year=y%201");
  assert.equal(studentSectionHref("c1", "s1"), "/dashboard/students/classes/c1/sections/s1");
  assert.equal(addStudentToSectionHref("s1"), "/dashboard/students/new?cohortId=s1");
});

test("only an exact section-page path is followed after adding a student", () => {
  const good = "/dashboard/students/classes/cmu5dxyup000gitgucbrqyopw/sections/cmu5dxyuq000iitgu8zwyd8ln";
  assert.equal(parseSectionReturnPath(good), good);

  for (const bad of [
    null,
    undefined,
    42,
    "",
    "https://evil.example/dashboard/students/classes/c/sections/s",
    "//evil.example/dashboard/students/classes/c/sections/s",
    "/dashboard/students",
    "/dashboard/students/classes/c1",
    "/dashboard/students/classes/c1/sections",
    "/dashboard/students/classes/c1/sections/s1/extra",
    "/dashboard/students/classes/c1/sections/s1?next=https://evil.example",
    "/dashboard/students/classes/c1/sections/s1#x",
    "/dashboard/students/classes/../../admin/sections/s1",
    "/dashboard/students/classes/c1/students/s1",
    "/dashboard/students/classes/c%2F1/sections/s1",
    "/dashboard/students/classes/c1/sections/s 1",
    `/dashboard/students/classes/${"c".repeat(65)}/sections/s1`,
  ]) {
    assert.equal(parseSectionReturnPath(bad), null, `accepted ${String(bad)}`);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { summarise } from "./coverage.ts";

/**
 * The arithmetic behind the coverage page.
 *
 * `summarise` is pure, so it is tested without a database. What matters is
 * that it never overstates coverage: a class that reads 100% when a student
 * has no sample is exactly the failure this page exists to prevent.
 */

const student = (id: string) => ({
  id,
  studentCode: id.toUpperCase(),
  firstName: "First",
  lastName: id,
});

const member = (cohortId: string, studentId: string) => ({
  cohortId,
  cohortName: `Class ${cohortId}`,
  termLabel: null,
  studentId,
});

test("counts distinct enrolled students, not samples", () => {
  const result = summarise(
    3,
    ["a", "b"],
    [{ modelName: "arcface", modelVersion: "1", samples: 7 }],
    [],
    [],
  );
  assert.equal(result.enrolledStudents, 2);
  assert.equal(result.samples, 7);
  assert.equal(result.activeStudents, 3);
});

test("per-class coverage counts only that class's members", () => {
  const result = summarise(
    3,
    ["a"],
    [],
    [member("x", "a"), member("x", "b"), member("y", "c")],
    [],
  );
  const byId = new Map(result.cohorts.map((cohort) => [cohort.cohortId, cohort]));
  assert.deepEqual(
    { students: byId.get("x")?.students, enrolled: byId.get("x")?.enrolled },
    { students: 2, enrolled: 1 },
  );
  assert.deepEqual(
    { students: byId.get("y")?.students, enrolled: byId.get("y")?.enrolled },
    { students: 1, enrolled: 0 },
  );
});

test("the worst-covered class is first, because the list is a to-do", () => {
  const result = summarise(
    4,
    ["a", "b"],
    [],
    [member("done", "a"), member("done", "b"), member("empty", "c"), member("empty", "d")],
    [],
  );
  assert.deepEqual(
    result.cohorts.map((cohort) => cohort.cohortId),
    ["empty", "done"],
  );
});

test("an enrolled student is never listed as missing", () => {
  const result = summarise(2, ["a"], [], [], [student("a"), student("b")]);
  assert.deepEqual(
    result.unenrolled.map((s) => s.id),
    ["b"],
  );
  assert.equal(result.unenrolledShown, 1);
});

test("a student with no samples in a fully enrolled-looking class still shows", () => {
  // The regression that matters: coverage must come from the embedding set,
  // not from the enrollment rows that happen to exist.
  const result = summarise(2, [], [], [member("x", "a"), member("x", "b")], []);
  assert.equal(result.cohorts[0]?.enrolled, 0);
});

test("names are assembled without a stray space when a surname is missing", () => {
  const result = summarise(1, [], [], [], [
    { id: "a", studentCode: "A", firstName: "Asha", lastName: "" },
  ]);
  assert.equal(result.unenrolled[0]?.name, "Asha");
});

test("nothing biometric is in the returned shape", () => {
  const result = summarise(1, ["a"], [{ modelName: "m", modelVersion: "1", samples: 1 }], [], []);
  const serialised = JSON.stringify(result);
  for (const forbidden of ["embedding", "sourceImageUrl", "vector", "image"]) {
    assert.ok(!serialised.includes(forbidden), `${forbidden} must not appear`);
  }
});

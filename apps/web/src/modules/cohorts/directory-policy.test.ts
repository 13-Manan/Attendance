import { test } from "node:test";
import assert from "node:assert/strict";
import {
  optionalId,
  requiredId,
  validateCohortName,
  validateTermLabel,
} from "./directory-policy.ts";
import { CohortError, MAX_COHORT_NAME, MAX_TERM_LABEL } from "./directory-types.ts";

/**
 * What a class is allowed to be called.
 *
 * The assertions that matter here are the ones about *not* changing what was
 * typed. A class name is copied off a timetable, and an institution that writes
 * "VIII A" must not find "Viii a" on the screen afterwards.
 */

test("a name is required, because a class with no name cannot be picked off a list", () => {
  for (const empty of ["", "   ", null, undefined]) {
    assert.throws(() => validateCohortName(empty), CohortError);
  }
});

test("surrounding whitespace is removed but nothing else is touched", () => {
  assert.equal(validateCohortName("  8-A  "), "8-A");
  assert.equal(validateCohortName("VIII A"), "VIII A");
  assert.equal(validateCohortName("b.tech cse — section a"), "b.tech cse — section a");
});

test("a name longer than the column is refused rather than silently cut", () => {
  const long = "x".repeat(MAX_COHORT_NAME + 1);
  assert.throws(() => validateCohortName(long), CohortError);
  // The boundary itself is allowed: an off-by-one here would refuse a name the
  // database would have taken.
  assert.equal(validateCohortName("x".repeat(MAX_COHORT_NAME)).length, MAX_COHORT_NAME);
});

test("an empty term is null, not an empty string", () => {
  // "" would read as a term whose name nobody filled in; null reads as "runs
  // all year", which is what an empty box means.
  assert.equal(validateTermLabel(""), null);
  assert.equal(validateTermLabel("   "), null);
  assert.equal(validateTermLabel(undefined), null);
  assert.equal(validateTermLabel("Term 1"), "Term 1");
});

test("a term longer than the column is refused", () => {
  assert.throws(() => validateTermLabel("x".repeat(MAX_TERM_LABEL + 1)), CohortError);
  assert.equal(validateTermLabel("x".repeat(MAX_TERM_LABEL))?.length, MAX_TERM_LABEL);
});

test("a required id refuses an unchosen dropdown with the caller's own sentence", () => {
  assert.throws(
    () => requiredId("", "Choose the academic year."),
    (error: unknown) =>
      error instanceof CohortError && error.message === "Choose the academic year.",
  );
  assert.equal(requiredId(" cohort-1 ", "unused"), "cohort-1");
});

test("an optional id treats a cleared dropdown as nobody rather than as an id", () => {
  assert.equal(optionalId(""), null);
  assert.equal(optionalId("   "), null);
  assert.equal(optionalId(null), null);
  assert.equal(optionalId("user-7"), "user-7");
});

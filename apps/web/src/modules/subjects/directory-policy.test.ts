import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSubjectCode, validateSubjectName } from "./directory-policy.ts";
import { MAX_SUBJECT_CODE, MAX_SUBJECT_NAME, SubjectError } from "./directory-types.ts";

/**
 * What a subject is allowed to be — the rules a form's contents meet before
 * anything else looks at them.
 */

test("a code is required, and the refusal shows what one looks like", () => {
  assert.throws(() => validateSubjectCode(""), SubjectError);
  assert.throws(() => validateSubjectCode("   "), /PHY301/);
  assert.throws(() => validateSubjectCode(undefined), /Enter a code/);
});

test("a code is trimmed but not upper-cased", () => {
  // The college's own timetable is the authority on how its codes are written,
  // and the unique constraint that enforces one-per-code is case-sensitive —
  // so rewriting the case here would enforce something different from what the
  // database does.
  assert.equal(validateSubjectCode("  PHY301  "), "PHY301");
  assert.equal(validateSubjectCode("phy301"), "phy301");
  assert.equal(validateSubjectCode("ME-2.1"), "ME-2.1");
});

test("the code length boundary is inclusive", () => {
  assert.equal(validateSubjectCode("x".repeat(MAX_SUBJECT_CODE)).length, MAX_SUBJECT_CODE);
  assert.throws(
    () => validateSubjectCode("x".repeat(MAX_SUBJECT_CODE + 1)),
    /40 characters or fewer/,
  );
});

test("a name is required and trimmed", () => {
  assert.throws(() => validateSubjectName(""), /Enter a name/);
  assert.throws(() => validateSubjectName("  "), SubjectError);
  assert.equal(validateSubjectName("  Quantum Mechanics "), "Quantum Mechanics");
});

test("the name length boundary is inclusive", () => {
  assert.equal(validateSubjectName("x".repeat(MAX_SUBJECT_NAME)).length, MAX_SUBJECT_NAME);
  assert.throws(
    () => validateSubjectName("x".repeat(MAX_SUBJECT_NAME + 1)),
    /160 characters or fewer/,
  );
});

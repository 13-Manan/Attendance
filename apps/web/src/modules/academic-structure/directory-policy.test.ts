import { test } from "node:test";
import assert from "node:assert/strict";
import {
  optionalId,
  validateKind,
  validateSortOrder,
  validateUnitCode,
  validateUnitName,
} from "./directory-policy.ts";
import {
  AcademicStructureError,
  MAX_SORT_ORDER,
  MAX_UNIT_CODE,
  MAX_UNIT_NAME,
} from "./directory-types.ts";

/**
 * What a part of the academic structure is allowed to be.
 *
 * These are the rules a form's contents meet before anything else looks at
 * them, so the tests are mostly about what is refused — and about what is
 * deliberately left alone, since an institution's own spelling of its
 * departments is not ours to tidy.
 */

test("a name is required, and the refusal says what to type", () => {
  assert.throws(() => validateUnitName("   "), AcademicStructureError);
  assert.throws(() => validateUnitName(""), /Enter a name/);
  assert.throws(() => validateUnitName(undefined), /Enter a name/);
});

test("a name is trimmed but not otherwise rewritten", () => {
  assert.equal(validateUnitName("  B.Tech CSE  "), "B.Tech CSE");
  // Not title-cased, not de-punctuated: three institutions write the same
  // department three ways, and the screen should match their prospectus.
  assert.equal(validateUnitName("b.tech cse"), "b.tech cse");
  assert.equal(validateUnitName("BTech-CSE"), "BTech-CSE");
});

test("the name length boundary is inclusive", () => {
  assert.equal(validateUnitName("x".repeat(MAX_UNIT_NAME)).length, MAX_UNIT_NAME);
  assert.throws(() => validateUnitName("x".repeat(MAX_UNIT_NAME + 1)), /120 characters or fewer/);
});

test("an empty code is null rather than an empty string", () => {
  // A blank string would print as a code nobody filled in.
  assert.equal(validateUnitCode(""), null);
  assert.equal(validateUnitCode("   "), null);
  assert.equal(validateUnitCode(null), null);
  assert.equal(validateUnitCode("CSE"), "CSE");
});

test("a code has a length limit", () => {
  assert.equal(validateUnitCode("x".repeat(MAX_UNIT_CODE))?.length, MAX_UNIT_CODE);
  assert.throws(() => validateUnitCode("x".repeat(MAX_UNIT_CODE + 1)), /40 characters or fewer/);
});

test("the kind must be one the institution is allowed to have", () => {
  assert.equal(validateKind("GRADE", ["GRADE", "SECTION", "GENERIC"]), "GRADE");
  // A school has no semesters. Refused here in a sentence; refused again in
  // service.ts against the type read from the database, which is the guarantee.
  assert.throws(
    () => validateKind("SEMESTER", ["GRADE", "SECTION", "GENERIC"]),
    /structure can hold/,
  );
  assert.throws(() => validateKind("", ["GRADE"]), /Choose what kind/);
  assert.throws(() => validateKind("NOT_A_KIND", ["GRADE"]), AcademicStructureError);
});

test("an empty order means 0 rather than an error", () => {
  assert.equal(validateSortOrder(""), 0);
  assert.equal(validateSortOrder(undefined), 0);
  assert.equal(validateSortOrder("12"), 12);
  assert.equal(validateSortOrder(" 3 "), 3);
});

test("a fractional or negative order is refused rather than rounded", () => {
  // Rounding "1.5" to 1 would leave two units claiming the same position with
  // nothing on screen to explain why the order looks wrong.
  assert.throws(() => validateSortOrder("1.5"), /whole number/);
  assert.throws(() => validateSortOrder("-1"), /whole number/);
  assert.throws(() => validateSortOrder("abc"), /whole number/);
  assert.throws(() => validateSortOrder(String(MAX_SORT_ORDER + 1)), /whole number/);
  assert.equal(validateSortOrder(String(MAX_SORT_ORDER)), MAX_SORT_ORDER);
});

test("a cleared dropdown is null, not an id", () => {
  assert.equal(optionalId(""), null);
  assert.equal(optionalId("   "), null);
  assert.equal(optionalId(undefined), null);
  assert.equal(optionalId("unit-1"), "unit-1");
});

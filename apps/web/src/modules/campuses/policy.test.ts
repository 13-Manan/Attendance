import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCampusAddress, validateCampusCode, validateCampusName } from "./policy.ts";
import { CampusError, MAX_CAMPUS_ADDRESS, MAX_CAMPUS_CODE, MAX_CAMPUS_NAME } from "./types.ts";

/**
 * What a campus is allowed to be.
 *
 * The code rules are the ones with teeth: the code is half of
 * `@@unique([institutionId, code])`, so anything that lets two codes differ
 * only by case or by invisible whitespace lets an institution end up with two
 * campuses a person cannot tell apart.
 */

test("a name is trimmed and required", () => {
  assert.equal(validateCampusName("  North Campus  "), "North Campus");
  assert.throws(() => validateCampusName(""), CampusError);
  assert.throws(() => validateCampusName("   "), CampusError);
  assert.throws(() => validateCampusName(null), CampusError);
});

test("a name has a stated ceiling rather than a silent truncation", () => {
  const atLimit = "a".repeat(MAX_CAMPUS_NAME);
  assert.equal(validateCampusName(atLimit), atLimit);
  assert.throws(() => validateCampusName("a".repeat(MAX_CAMPUS_NAME + 1)), CampusError);
});

test("a code is upper-cased, so two campuses cannot differ only by case", () => {
  // Postgres compares text case-sensitively, so "north" and "North" would
  // both satisfy @@unique([institutionId, code]) and produce two campuses
  // nobody can tell apart in a list.
  assert.equal(validateCampusCode("north"), "NORTH");
  assert.equal(validateCampusCode("  main  "), "MAIN");
  assert.equal(validateCampusCode("Campus-2"), "CAMPUS-2");
});

test("surrounding whitespace is trimmed, including the kind that does not look like it", () => {
  // A non-breaking space survives a copy-paste out of a spreadsheet and is
  // invisible in the form. It is removed rather than refused, because the
  // administrator did type a valid code — they just brought a passenger.
  assert.equal(validateCampusCode("MAIN "), "MAIN");
  assert.equal(validateCampusName(" North Campus "), "North Campus");
});

test("a code refuses spaces and punctuation instead of stripping them", () => {
  // Silently turning "North Campus" into "NORTHCAMPUS" hands back a code the
  // administrator did not choose and will not recognise later. The lone "с"
  // is Cyrillic: it upper-cases to "С", which is not the Latin "C" and must
  // not be allowed to sit next to one in a list of codes.
  for (const bad of ["North Campus", "MAIN!", "a.b", "code/1", "с", "MAIN 2"]) {
    assert.throws(() => validateCampusCode(bad), CampusError, bad);
  }
});

test("a code is required and bounded", () => {
  assert.throws(() => validateCampusCode(""), CampusError);
  assert.throws(() => validateCampusCode("   "), CampusError);
  const atLimit = "A".repeat(MAX_CAMPUS_CODE);
  assert.equal(validateCampusCode(atLimit), atLimit);
  assert.throws(() => validateCampusCode("A".repeat(MAX_CAMPUS_CODE + 1)), CampusError);
});

test("an empty address is null, not an empty string", () => {
  // So "no address on file" is one value in the database rather than two that
  // render differently.
  assert.equal(validateCampusAddress(""), null);
  assert.equal(validateCampusAddress("   "), null);
  assert.equal(validateCampusAddress(undefined), null);
  assert.equal(validateCampusAddress(" 12 Nehru Road "), "12 Nehru Road");
});

test("an over-long address is refused rather than cut short", () => {
  assert.throws(() => validateCampusAddress("x".repeat(MAX_CAMPUS_ADDRESS + 1)), CampusError);
});

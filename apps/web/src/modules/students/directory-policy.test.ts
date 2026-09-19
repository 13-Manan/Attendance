import { test } from "node:test";
import assert from "node:assert/strict";
import {
  optionalId,
  parseAdmissionDate,
  validateAdmissionNumber,
  validateStudentCode,
  validateStudentEmail,
  validateStudentName,
  validateStudentPhone,
  validateStudentStatus,
} from "./directory-policy.ts";
import {
  MAX_ADMISSION_NUMBER,
  MAX_STUDENT_CODE,
  MAX_STUDENT_EMAIL,
  MAX_STUDENT_NAME,
  MAX_STUDENT_PHONE,
  StudentError,
} from "./directory-types.ts";

/**
 * What a student record is allowed to be.
 *
 * Pure, and the clock is injected, so none of this depends on the day the
 * tests are run. The parts with teeth are the admission date — a day out on
 * every record is the bug nobody believes until it is shown against a transfer
 * certificate — and the status, which must never quietly default.
 */

const NOW = new Date("2026-09-20T00:00:00.000Z");

test("a name is trimmed, required and bounded", () => {
  assert.equal(validateStudentName("  Priya  ", "first name"), "Priya");
  assert.throws(() => validateStudentName("", "first name"), StudentError);
  assert.throws(() => validateStudentName("   ", "last name"), StudentError);
  const atLimit = "n".repeat(MAX_STUDENT_NAME);
  assert.equal(validateStudentName(atLimit, "first name"), atLimit);
  assert.throws(() => validateStudentName("n".repeat(MAX_STUDENT_NAME + 1), "first name"), StudentError);
});

test("the refusal names the field that was left empty", () => {
  assert.throws(
    () => validateStudentName("", "last name"),
    (error: unknown) => error instanceof StudentError && error.message.includes("last name"),
  );
});

test("a student code is required and kept exactly as it was typed", () => {
  // Not upper-cased: it is the institution's own string, and rewriting its
  // case would make the record disagree with the paper register.
  assert.equal(validateStudentCode("  s-2026/014  "), "s-2026/014");
  assert.throws(() => validateStudentCode(""), StudentError);
  assert.throws(() => validateStudentCode("c".repeat(MAX_STUDENT_CODE + 1)), StudentError);
});

test("an empty optional field is absent, never an empty string", () => {
  // "" in the database reads as "recorded as blank"; null reads as "not on
  // file", which is what an empty box means.
  assert.equal(validateStudentEmail(""), null);
  assert.equal(validateStudentEmail("   "), null);
  assert.equal(validateStudentPhone(""), null);
  assert.equal(validateAdmissionNumber("   "), null);
  assert.equal(parseAdmissionDate("", NOW), null);
  assert.equal(optionalId(""), null);
  assert.equal(validateStudentEmail(undefined), null);
  assert.equal(validateStudentPhone(null), null);
});

test("an email is lower-cased, because one inbox should not look like two people", () => {
  assert.equal(validateStudentEmail("  R.Sharma@Example.EDU "), "r.sharma@example.edu");
});

test("an email that is not an address is refused", () => {
  for (const bad of ["nope", "a@b", "a@b@c.d", "priya sharma@example.edu", "@example.edu"]) {
    assert.throws(() => validateStudentEmail(bad), StudentError, bad);
  }
  assert.throws(
    () => validateStudentEmail(`${"a".repeat(MAX_STUDENT_EMAIL)}@example.edu`),
    StudentError,
  );
});

test("an email with a plus tag or a long suffix is accepted", () => {
  // Stricter patterns reject addresses that work, and the only thing that
  // proves an address is real is sending to it.
  assert.equal(validateStudentEmail("priya+school@example.education"), "priya+school@example.education");
});

test("a phone number is kept however it was written", () => {
  for (const good of ["+91 98765 43210", "098765-43210", "(022) 2345 6789"]) {
    assert.equal(validateStudentPhone(good), good);
  }
});

test("a note typed into the phone box is refused", () => {
  assert.throws(() => validateStudentPhone("call the mother"), StudentError);
  assert.throws(() => validateStudentPhone("12345"), StudentError, "too short to dial");
  assert.throws(() => validateStudentPhone("1".repeat(MAX_STUDENT_PHONE + 1)), StudentError);
});

test("an admission number is optional, bounded, and not unique", () => {
  assert.equal(validateAdmissionNumber("  ADM/2026/0014 "), "ADM/2026/0014");
  assert.throws(() => validateAdmissionNumber("a".repeat(MAX_ADMISSION_NUMBER + 1)), StudentError);
});

test("an admission date is the calendar day that was typed, at UTC midnight", () => {
  const date = parseAdmissionDate("2026-06-01", NOW);
  assert.equal(date?.toISOString(), "2026-06-01T00:00:00.000Z");
});

test("a date that is not a date is refused, and so is one that does not exist", () => {
  for (const bad of ["01/06/2026", "June 2026", "2026-6-1", "tomorrow"]) {
    assert.throws(() => parseAdmissionDate(bad, NOW), StudentError, bad);
  }
  // `Date.UTC` rolls 31 February forward into March rather than refusing it,
  // so the round-trip comparison is what catches this.
  assert.throws(() => parseAdmissionDate("2026-02-31", NOW), StudentError);
  assert.throws(() => parseAdmissionDate("2026-13-01", NOW), StudentError);
});

test("a mistyped year is refused at both ends", () => {
  // The future end is the one that matters: "sort by newest admission" would
  // put a mistyped 2206 at the top of the list for the life of the record.
  assert.throws(() => parseAdmissionDate("2206-06-01", NOW), StudentError);
  assert.throws(() => parseAdmissionDate("1899-06-01", NOW), StudentError);
  // Two years ahead is allowed: institutions admit for next session.
  assert.ok(parseAdmissionDate("2028-06-01", NOW));
  assert.throws(() => parseAdmissionDate("2029-06-01", NOW), StudentError);
});

test("a status has to be one of the four, and never defaults", () => {
  assert.equal(validateStudentStatus("active"), "ACTIVE");
  assert.equal(validateStudentStatus(" Completed "), "COMPLETED");
  // A form that fell back to ACTIVE when handed something unexpected is a form
  // through which a crafted request puts a student who has left back on every
  // class list.
  for (const bad of ["", "   ", "EXPELLED", "true", null, undefined, 1]) {
    assert.throws(() => validateStudentStatus(bad), StudentError, String(bad));
  }
});

test("an id is either a string or nothing, and is not checked for existence here", () => {
  // That it names a row in *this* institution cannot be known without a
  // database, and is checked in the service before anything is written.
  assert.equal(optionalId("  cohort-1  "), "cohort-1");
  assert.equal(optionalId(null), null);
  assert.equal(optionalId(undefined), null);
});

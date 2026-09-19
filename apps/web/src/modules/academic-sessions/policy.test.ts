import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_STATE_LABEL,
  parseSessionDate,
  sessionState,
  validateDateRange,
  validateSessionName,
} from "./policy.ts";
import { AcademicSessionError, MAX_SESSION_NAME } from "./types.ts";

/**
 * What an academic year is allowed to be.
 *
 * The date parsing is the part with teeth: a year that starts a day earlier in
 * the database than on the form would misfile a register and nobody would know
 * which one.
 */

test("a name is trimmed, required and bounded", () => {
  assert.equal(validateSessionName("  2026-27  "), "2026-27");
  assert.throws(() => validateSessionName(""), AcademicSessionError);
  assert.throws(() => validateSessionName("   "), AcademicSessionError);
  const atLimit = "y".repeat(MAX_SESSION_NAME);
  assert.equal(validateSessionName(atLimit), atLimit);
  assert.throws(() => validateSessionName("y".repeat(MAX_SESSION_NAME + 1)), AcademicSessionError);
});

test("a date is read as the calendar day that was typed, at UTC midnight", () => {
  // Not `new Date(text)` with a local interpretation: west of Greenwich that
  // stores the day before, and an academic year that starts "31 May" in the
  // database and "1 June" on the form is a bug nobody believes until it is
  // demonstrated.
  const date = parseSessionDate("2026-06-01", "start date");
  assert.equal(date.toISOString(), "2026-06-01T00:00:00.000Z");
});

test("a date that is not a date is refused, and so is one that does not exist", () => {
  for (const bad of ["", "   ", "01/06/2026", "June 2026", "2026-6-1"]) {
    assert.throws(() => parseSessionDate(bad, "start date"), AcademicSessionError, bad);
  }
  // `Date.UTC` rolls 31 February forward into March rather than refusing it,
  // so the round-trip check is what catches this.
  assert.throws(() => parseSessionDate("2026-02-31", "start date"), AcademicSessionError);
  assert.throws(() => parseSessionDate("2026-13-01", "start date"), AcademicSessionError);
});

test("the refusal names the field that was wrong", () => {
  assert.throws(
    () => parseSessionDate("", "end date"),
    (error: unknown) =>
      error instanceof AcademicSessionError && error.message.includes("end date"),
  );
});

test("a year has to end after it starts, and a zero-length year is not a year", () => {
  const start = parseSessionDate("2026-06-01", "start date");
  validateDateRange(start, parseSessionDate("2027-03-31", "end date"));
  assert.throws(() => validateDateRange(start, start), AcademicSessionError);
  assert.throws(
    () => validateDateRange(start, parseSessionDate("2026-05-31", "end date")),
    AcademicSessionError,
  );
});

test("an unusual but real year is accepted", () => {
  // A nine-month year, a two-year programme and a summer term that overlaps
  // both are all things institutions actually run. Nothing here checks that a
  // year is about a year long, or that it does not overlap its neighbour.
  validateDateRange(
    parseSessionDate("2026-07-01", "start date"),
    parseSessionDate("2026-12-31", "end date"),
  );
  validateDateRange(
    parseSessionDate("2026-06-01", "start date"),
    parseSessionDate("2028-05-31", "end date"),
  );
});

test("there are three states, and the third is the one a single flag cannot express", () => {
  // An institution sets next year up in March while this year is still
  // running: that year is open, and it is not current.
  assert.equal(sessionState({ isActive: true, isCurrent: true }), "current");
  assert.equal(sessionState({ isActive: true, isCurrent: false }), "open");
  assert.equal(sessionState({ isActive: false, isCurrent: false }), "archived");
});

test("an archived year reads as archived even if it still carries the current flag", () => {
  // Not a state the service can produce — archiving the current year is
  // refused — but the label must not claim a year is current when it has been
  // taken out of use by hand in the database.
  assert.equal(sessionState({ isActive: false, isCurrent: true }), "archived");
});

test("every state has a label a person would say out loud", () => {
  assert.deepEqual(Object.keys(SESSION_STATE_LABEL).sort(), ["archived", "current", "open"]);
  for (const label of Object.values(SESSION_STATE_LABEL)) {
    assert.ok(label.length > 0);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listTimezoneOptions,
  resolveLabels,
  validateAcademicUnitLabels,
  validateAddressLine,
  validateContactEmail,
  validateContactPhone,
  validateInstitutionName,
  validateTimezone,
} from "./policy.ts";
import {
  InstitutionProfileError,
  MAX_ADDRESS_LINE,
  MAX_CONTACT_PHONE,
  MAX_INSTITUTION_NAME,
  MAX_UNIT_LABEL,
} from "./types.ts";
import { DEFAULT_ACADEMIC_UNIT_LABELS } from "../institutions/types.ts";

/**
 * What an institution's profile is allowed to be.
 *
 * The time zone is the one with teeth — it is the answer to "which day is this
 * register for" — so it is checked against the runtime's own zone database
 * rather than against a list written here.
 */

test("a name is trimmed, required and bounded", () => {
  assert.equal(validateInstitutionName("  Green Valley School  "), "Green Valley School");
  assert.throws(() => validateInstitutionName(""), InstitutionProfileError);
  assert.throws(() => validateInstitutionName("   "), InstitutionProfileError);
  const atLimit = "a".repeat(MAX_INSTITUTION_NAME);
  assert.equal(validateInstitutionName(atLimit), atLimit);
  assert.throws(
    () => validateInstitutionName("a".repeat(MAX_INSTITUTION_NAME + 1)),
    InstitutionProfileError,
  );
});

// ---------------------------------------------------------------------------
// Time zone
// ---------------------------------------------------------------------------

test("a real IANA zone is accepted exactly as written", () => {
  // Not upper-cased or otherwise normalised: IANA names are case-sensitive and
  // "ASIA/KOLKATA" is not a zone.
  assert.equal(validateTimezone("Asia/Kolkata"), "Asia/Kolkata");
  assert.equal(validateTimezone("  UTC  "), "UTC");
  assert.equal(validateTimezone("Europe/London"), "Europe/London");
});

test("an invented zone is refused with the name that was tried", () => {
  for (const bad of ["Mars/Olympus", "Asia/Kolkatta", "Pune"]) {
    assert.throws(
      () => validateTimezone(bad),
      (error: unknown) =>
        error instanceof InstitutionProfileError && error.message.includes(bad),
      bad,
    );
  }
});

test("a fixed offset is refused even though the runtime accepts it", () => {
  // `Intl.DateTimeFormat` is happy with "+05:30". It is still the wrong thing
  // to store: an offset is a fact about one moment, a zone is a rule. An
  // institution on "-05:00" would file an hour of registers against the wrong
  // day the first spring after daylight saving started, and nothing in the
  // product would look broken.
  for (const bad of ["+05:30", "-08:00", "+00:00"]) {
    assert.throws(
      () => validateTimezone(bad),
      (error: unknown) =>
        error instanceof InstitutionProfileError &&
        error.message.includes(bad) &&
        error.message.includes("daylight saving"),
      bad,
    );
  }
});

test("a zone is stored as typed, not rewritten to the runtime's canonical name", () => {
  // This build's ICU canonicalises Asia/Kolkata to Asia/Calcutta. Normalising
  // would hand an Indian administrator back a spelling their own government
  // stopped using in 1995, so the value is returned untouched.
  assert.equal(validateTimezone("Asia/Kolkata"), "Asia/Kolkata");
  assert.notEqual(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata" }).resolvedOptions().timeZone,
    "Asia/Kolkata",
  );
});

test("an empty zone is refused rather than silently defaulting to UTC", () => {
  // Defaulting would file an Indian institution's evening registers against
  // the wrong day and nobody would have chosen it.
  assert.throws(() => validateTimezone(""), InstitutionProfileError);
  assert.throws(() => validateTimezone("   "), InstitutionProfileError);
  assert.throws(() => validateTimezone(null), InstitutionProfileError);
});

test("the offered zones always contain the one already stored", () => {
  // `Intl.supportedValuesOf` lists neither "UTC" — the column default, so
  // every institution that has never set a zone is on it — nor "Asia/Kolkata".
  // Without the prepend the form would silently propose a change to an
  // institution that only opened the page.
  const zones = Intl.supportedValuesOf("timeZone");
  assert.ok(!zones.includes("UTC"));
  assert.ok(!zones.includes("Asia/Kolkata"));

  assert.equal(listTimezoneOptions("Asia/Kolkata")[0], "Asia/Kolkata");
  assert.equal(listTimezoneOptions("UTC")[0], "UTC");
  assert.ok(listTimezoneOptions("UTC").includes("Europe/London"));
});

test("the offered zones are listed once each", () => {
  const options = listTimezoneOptions("Europe/London");
  assert.equal(options[0], "Europe/London");
  assert.equal(new Set(options).size, options.length, "no zone appears twice");
  assert.ok(options.includes("UTC"), "the column default is always offered");
});

// ---------------------------------------------------------------------------
// Contact details
// ---------------------------------------------------------------------------

test("an empty contact field is null, not an empty string", () => {
  assert.equal(validateContactEmail(""), null);
  assert.equal(validateContactPhone("   "), null);
  assert.equal(validateAddressLine(undefined), null);
});

test("a contact email is lower-cased and loosely shape-checked", () => {
  assert.equal(validateContactEmail("  Office@Example.EDU "), "office@example.edu");
  assert.equal(validateContactEmail("first+tag@sub.example.co.in"), "first+tag@sub.example.co.in");
  for (const bad of ["office", "office@", "@example.edu", "a b@example.edu"]) {
    assert.throws(() => validateContactEmail(bad), InstitutionProfileError, bad);
  }
});

test("a phone number is kept as the institution writes it", () => {
  // Reformatting hands back a number the administrator did not enter, and
  // institutions print these on their own stationery.
  assert.equal(validateContactPhone(" +91 20 2612 3456 "), "+91 20 2612 3456");
  assert.equal(validateContactPhone("(020) 2612-3456"), "(020) 2612-3456");
});

test("a phone number with no digits at all is refused", () => {
  for (const bad of ["call us", "+", "---", "office@example.edu"]) {
    assert.throws(() => validateContactPhone(bad), InstitutionProfileError, bad);
  }
  assert.throws(
    () => validateContactPhone("1".repeat(MAX_CONTACT_PHONE + 1)),
    InstitutionProfileError,
  );
});

test("an address keeps its line breaks and has a stated ceiling", () => {
  assert.equal(validateAddressLine("12 Nehru Road\nPune 411001"), "12 Nehru Road\nPune 411001");
  assert.throws(
    () => validateAddressLine("x".repeat(MAX_ADDRESS_LINE + 1)),
    InstitutionProfileError,
  );
});

// ---------------------------------------------------------------------------
// Academic unit labels
// ---------------------------------------------------------------------------

test("a blank label restores the default rather than blanking the word", () => {
  const overrides = validateAcademicUnitLabels({ GRADE: "  ", SECTION: "" });
  assert.deepEqual(overrides, {});
  assert.equal(resolveLabels(overrides).GRADE, DEFAULT_ACADEMIC_UNIT_LABELS.GRADE);
});

test("a label equal to the shipped default is not stored as an override", () => {
  // Otherwise every institution that opened the form and pressed Save would
  // carry six redundant overrides, and a future change to the shipped wording
  // would silently miss all of them.
  const overrides = validateAcademicUnitLabels({
    GRADE: DEFAULT_ACADEMIC_UNIT_LABELS.GRADE,
    SECTION: "Division",
  });
  assert.deepEqual(overrides, { SECTION: "Division" });
});

test("only the known label keys are stored", () => {
  const overrides = validateAcademicUnitLabels({ SECTION: "Division", HOUSE: "Sparrow" });
  assert.deepEqual(overrides, { SECTION: "Division" });
});

test("a label is trimmed and bounded, and the refusal names which word", () => {
  assert.deepEqual(validateAcademicUnitLabels({ SECTION: "  Division  " }), {
    SECTION: "Division",
  });
  assert.throws(
    () => validateAcademicUnitLabels({ SECTION: "x".repeat(MAX_UNIT_LABEL + 1) }),
    (error: unknown) =>
      error instanceof InstitutionProfileError && error.message.includes("Section"),
  );
});

test("resolving overlays overrides on the defaults and survives junk", () => {
  assert.deepEqual(resolveLabels({ SEMESTER: "Term" }), {
    ...DEFAULT_ACADEMIC_UNIT_LABELS,
    SEMESTER: "Term",
  });
  // A settings column holding null, a string or an array must not throw on a
  // page that only wants to render a heading.
  for (const junk of [null, undefined, "labels", 7, ["SECTION"]]) {
    assert.deepEqual(resolveLabels(junk), DEFAULT_ACADEMIC_UNIT_LABELS);
  }
});

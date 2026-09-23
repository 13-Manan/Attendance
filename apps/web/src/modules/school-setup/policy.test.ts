import { test } from "node:test";
import assert from "node:assert/strict";
import {
  duplicateNames,
  pickYear,
  sameName,
  sectionGroupName,
  sectionLabel,
  sectionStatus,
  shortClassLabel,
  suggestSectionName,
  tidyName,
  validateClassName,
  validateSectionName,
  validateSectionNames,
} from "./policy.ts";
import { SchoolSetupError } from "./types.ts";

test("names are compared trimmed, with spaces collapsed and without regard to case", () => {
  assert.equal(tidyName("  Class   8 "), "Class 8");
  assert.equal(sameName("section a", "SECTION  A"), true);
  assert.equal(sameName("A", "B"), false);
});

test("an empty class name is refused with an example", () => {
  assert.throws(() => validateClassName("   "), /Enter a class name, for example Class 8/);
  assert.equal(validateClassName(" Class  8 "), "Class 8");
  assert.throws(() => validateClassName("x".repeat(121)), SchoolSetupError);
});

test("an empty or overlong section name is refused", () => {
  assert.throws(() => validateSectionName(""), /Enter a section name/);
  assert.throws(() => validateSectionName("x".repeat(41)), /at most 40/);
});

test("section names are checked as a set: count, blanks and case-insensitive duplicates", () => {
  assert.deepEqual(validateSectionNames(["A", "B", "Rose"]), ["A", "B", "Rose"]);
  assert.throws(() => validateSectionNames([]), /at least one section/);
  assert.throws(() => validateSectionNames(Array.from({ length: 31 }, (_, i) => `S${i}`)), /at most 30/);
  assert.throws(() => validateSectionNames(["A", " "]), /Section 2 needs a name/);
  assert.throws(() => validateSectionNames(["A", "B", "a"]), /"A" is used for more than one section/);
});

test("duplicateNames reports each clash once, in first-seen spelling", () => {
  assert.deepEqual(duplicateNames(["Rose", "lily", "ROSE", "Lily", "rose", ""]), ["Rose", "lily"]);
  assert.deepEqual(duplicateNames(["A", "B"]), []);
});

test("suggested section names are A–Z, then numbers — only a suggestion", () => {
  assert.equal(suggestSectionName(0), "A");
  assert.equal(suggestSectionName(3), "D");
  assert.equal(suggestSectionName(25), "Z");
  assert.equal(suggestSectionName(26), "27");
});

test("the group name reads the way a school writes it", () => {
  assert.equal(shortClassLabel("Class 8"), "8");
  assert.equal(shortClassLabel("Grade VII"), "VII");
  assert.equal(shortClassLabel("Std. 5"), "5");
  assert.equal(shortClassLabel("Nursery"), "Nursery");
  assert.equal(sectionGroupName("Class 8", "A"), "8-A");
  assert.equal(sectionGroupName("Upper KG", "Rose"), "Upper KG - Rose");
});

test("a section already named \"Section A\" is not labelled twice", () => {
  assert.equal(sectionLabel("A"), "Section A");
  assert.equal(sectionLabel("section  a"), "section a");
  assert.equal(sectionLabel("Sectional"), "Section Sectional");
  // Both read as "Section A", so they are the same section.
  assert.deepEqual(duplicateNames(["A", "Section a"]), ["A"]);
});

test("a section is ready only with a teacher who can sign in", () => {
  assert.equal(sectionStatus(null), "needs_teacher");
  assert.equal(sectionStatus({ linkId: "l", userId: "u", name: "P", active: true }), "ready");
  assert.equal(sectionStatus({ linkId: "l", userId: "u", name: "P", active: false }), "teacher_inactive");
});

test("pickYear: the requested year, else the current one, else the first open one", () => {
  const years = [
    { id: "next", isCurrent: false, isActive: true },
    { id: "now", isCurrent: true, isActive: true },
    { id: "old", isCurrent: false, isActive: false },
  ];
  assert.equal(pickYear(years, "old")?.id, "old");
  assert.equal(pickYear(years, "someone-elses")?.id, "now");
  assert.equal(pickYear(years, undefined)?.id, "now");
  assert.equal(pickYear([years[0], years[2]], undefined)?.id, "next");
  assert.equal(pickYear([years[2]], undefined), null);
});

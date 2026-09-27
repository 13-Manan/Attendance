import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_STUDENT_SEARCH,
  courseStatus,
  defaultSemesterName,
  nextSectionNames,
  ordinal,
  parseStudentCodes,
  pickSession,
  sectionFullName,
  sectionGroupName,
  sectionRemovalCheck,
  sectionStatus,
  studentMatchesSearch,
  studentSearchTerms,
  validateCourseCode,
  validateCourseName,
  validateDepartmentCode,
  validateDepartmentName,
  validateSectionNames,
  validateSemesterName,
  validateSemesterNumber,
} from "./policy.ts";
import { CollegeSetupError, MAX_SECTIONS } from "./types.ts";

const refuses = (fn: () => unknown, pattern: RegExp) =>
  assert.throws(fn, (error: Error) => error instanceof CollegeSetupError && pattern.test(error.message));

test("department names are tidied, and codes are stored in capitals", () => {
  assert.equal(validateDepartmentName("  Computer   Science "), "Computer Science");
  assert.equal(validateDepartmentCode(" cse "), "CSE");
  assert.equal(validateDepartmentCode("e&tc"), "E&TC");
  refuses(() => validateDepartmentName("   "), /Enter a department name/);
  refuses(() => validateDepartmentCode(""), /short department code/);
  refuses(() => validateDepartmentCode("CS<script>"), /letters, digits/);
  refuses(() => validateDepartmentCode("X".repeat(17)), /at most 16/);
});

test("course codes are unique-able strings in capitals; names are required", () => {
  assert.equal(validateCourseCode(" phy401 "), "PHY401");
  assert.equal(validateCourseCode("cs-301l"), "CS-301L");
  assert.equal(validateCourseName(" Physics "), "Physics");
  refuses(() => validateCourseCode(""), /course code/);
  refuses(() => validateCourseCode("PHY 401;DROP"), /letters, digits/);
  refuses(() => validateCourseName(""), /course name/);
});

test("a semester is a number from 1 to 12, named after it unless typed otherwise", () => {
  assert.equal(validateSemesterNumber("4"), 4);
  refuses(() => validateSemesterNumber("0"), /from 1 to 12/);
  refuses(() => validateSemesterNumber("13"), /from 1 to 12/);
  refuses(() => validateSemesterNumber("2.5"), /from 1 to 12/);
  refuses(() => validateSemesterNumber(""), /from 1 to 12/);
  assert.equal(validateSemesterName("", 4), "4th Semester");
  assert.equal(validateSemesterName("  Sem IV ", 4), "Sem IV");
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(ordinal), [
    "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd",
  ]);
  assert.equal(defaultSemesterName(1), "1st Semester");
});

test("section names are checked as a set, ignoring case and a leading 'Section'", () => {
  assert.deepEqual(validateSectionNames(["A", " B ", "c"]), ["A", "B", "c"]);
  refuses(() => validateSectionNames(["A", "section a"]), /"A" is used for more than one section/);
  refuses(() => validateSectionNames([]), /at least one section/);
  refuses(() => validateSectionNames(["A", ""]), /Section 2 needs a name/);
  refuses(() => validateSectionNames(Array.from({ length: MAX_SECTIONS + 1 }, (_, i) => `S${i}`)), /at most/);
});

test("a section's register name is its course code and its own name", () => {
  assert.equal(sectionGroupName("PHY401", "A"), "PHY401-A");
  assert.equal(sectionGroupName("PHY401", "Section B"), "PHY401-B");
  assert.equal(sectionGroupName("MA 101", "A"), "MA 101 - A");
});

test("a course is ready only when every section this session has a teacher who can sign in", () => {
  const ready = { status: sectionStatus({ userId: "t", name: "T", active: true }) };
  const stopped = { status: sectionStatus({ userId: "t", name: "T", active: false }) };
  const empty = { status: sectionStatus(null) };
  assert.equal(ready.status, "ready");
  assert.equal(stopped.status, "teacher_inactive");
  assert.equal(empty.status, "needs_teacher");
  assert.equal(courseStatus([]), "no_sections");
  assert.equal(courseStatus([ready, ready]), "ready");
  assert.equal(courseStatus([ready, empty]), "needs_teacher");
  assert.equal(courseStatus([ready, stopped]), "needs_teacher");
});

test("the session shown is the one asked for, else the current one, else the latest open one", () => {
  const sessions = [
    { id: "next", isCurrent: false, isActive: true },
    { id: "now", isCurrent: true, isActive: true },
    { id: "old", isCurrent: false, isActive: false },
  ];
  assert.equal(pickSession(sessions, "old")?.id, "old");
  assert.equal(pickSession(sessions, "someone-elses")?.id, "now");
  assert.equal(pickSession(sessions, undefined)?.id, "now");
  assert.equal(pickSession([{ id: "a", isCurrent: false, isActive: false }], undefined), null);
});

test("a section that has been used is kept, with every reason at once", () => {
  const nothing = { students: 0, currentStudents: 0, registers: 0, subjectEnrollments: 0, otherSubjects: 0, externalLinks: 0 };
  assert.deepEqual(sectionRemovalCheck(nothing, { name: "2026-27", isActive: true }), { allowed: true, reasons: [] });
  const used = sectionRemovalCheck(
    { ...nothing, students: 3, currentStudents: 1, registers: 2, externalLinks: 1 },
    { name: "2025-26", isActive: false },
  );
  assert.equal(used.allowed, false);
  assert.equal(used.reasons.length, 4);
  assert.match(used.reasons.join(" "), /archived/);
  assert.match(used.reasons.join(" "), /3 students have been placed in this section \(1 still in it\)/);
  assert.match(used.reasons.join(" "), /Attendance has been taken for this section 2 times/);
});

test("student IDs are read from commas, spaces and lines, each once, within a limit", () => {
  assert.deepEqual(parseStudentCodes("CSE01, cse02\nCSE03 CSE01;cse01", 10), ["CSE01", "cse02", "CSE03", "cse01"]);
  refuses(() => parseStudentCodes("  , ", 10), /at least one student ID/);
  refuses(() => parseStudentCodes("a b c", 2), /at most 2/);
});

test("the next section suggested is the first letter not taken, however the others were written", () => {
  assert.deepEqual(nextSectionNames([], 3), ["A", "B", "C"]);
  assert.deepEqual(nextSectionNames(["A", "section b", "D"], 2), ["C", "E"]);
  assert.deepEqual(nextSectionNames(["Section A"], 1), ["B"]);
  const alphabet = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
  assert.deepEqual(nextSectionNames(alphabet, 1), ["27"], "past Z, numbers");
});

test("a section is named in full with its course", () => {
  assert.equal(sectionFullName("Physics", "Section A"), "Physics — Section A");
  assert.equal(sectionFullName("  Applied   Physics ", "CSE Sem 3 - Section 1"), "Applied Physics — CSE Sem 3 - Section 1");
});

test("a student search becomes terms only once there is enough to search on", () => {
  assert.equal(MIN_STUDENT_SEARCH, 2);
  assert.deepEqual(studentSearchTerms(""), []);
  assert.deepEqual(studentSearchTerms(" a "), [], "one letter matches half the college");
  assert.deepEqual(studentSearchTerms("CSE001"), ["CSE001"]);
  assert.deepEqual(studentSearchTerms("  aman   kumar "), ["aman", "kumar"]);
  assert.deepEqual(studentSearchTerms("Aman aman AMAN"), ["Aman"], "a repeated word is one term");
  assert.deepEqual(studentSearchTerms("a b c d e f"), ["a", "b", "c", "d"], "at most four terms");
  assert.equal(studentSearchTerms("x".repeat(500))[0].length, 80, "a pasted paragraph is cut short");
  assert.deepEqual(studentSearchTerms(null), []);
});

test("a section's own list search needs every word in the name or the student ID", () => {
  const aman = { firstName: "Aman", lastName: "Kumar", studentCode: "CSE001" };
  assert.equal(studentMatchesSearch(aman, "aman"), true);
  assert.equal(studentMatchesSearch(aman, "kumar aman"), true);
  assert.equal(studentMatchesSearch(aman, "cse00"), true);
  assert.equal(studentMatchesSearch(aman, "aman singh"), false);
  assert.equal(studentMatchesSearch(aman, "   "), true, "nothing typed hides nobody");
});

import {
  duplicateNames,
  nameKey,
  sameName,
  sameSectionName,
  sectionKey,
  sectionLabel,
  tidyName,
} from "@/modules/school-setup/policy";
import {
  CollegeSetupError,
  MAX_COURSE_CODE,
  MAX_COURSE_NAME,
  MAX_DEPARTMENT_CODE,
  MAX_DEPARTMENT_NAME,
  MAX_SECTIONS,
  MAX_SECTION_NAME,
  MAX_SEMESTER_NAME,
  MAX_SEMESTER_NUMBER,
  type CourseStatus,
  type RemovalCheck,
  type SectionRow,
  type SectionStatus,
  type SectionTeacher,
} from "./types";

/**
 * What a college's departments, semesters, courses and sections may be
 * called, and the small decisions the screens show.
 *
 * Pure, so a form can run the same checks in the browser that the server runs
 * again before writing. The name comparisons are the school screens' own
 * (`school-setup/policy.ts`): one rule for "are these the same name" across
 * the product.
 */

export { duplicateNames, nameKey, sameName, sameSectionName, sectionKey, sectionLabel, tidyName };

export function validateDepartmentName(raw: unknown): string {
  const name = tidyName(String(raw ?? ""));
  if (name === "") throw new CollegeSetupError("Enter a department name, for example Computer Science.");
  if (name.length > MAX_DEPARTMENT_NAME) {
    throw new CollegeSetupError(`A department name can be at most ${MAX_DEPARTMENT_NAME} characters.`);
  }
  return name;
}

/**
 * A department's short code: letters, digits and a few joiners, stored in
 * capitals so "cse" and "CSE" are one code.
 */
export function validateDepartmentCode(raw: unknown): string {
  const code = tidyName(String(raw ?? "")).toUpperCase();
  if (code === "") throw new CollegeSetupError("Enter a short department code, for example CSE.");
  if (code.length > MAX_DEPARTMENT_CODE) {
    throw new CollegeSetupError(`A department code can be at most ${MAX_DEPARTMENT_CODE} characters.`);
  }
  if (!/^[A-Z0-9][A-Z0-9&.\- ]*$/.test(code)) {
    throw new CollegeSetupError(
      "A department code can use letters, digits, spaces and the characters & . - only.",
    );
  }
  return code;
}

export function validateCourseName(raw: unknown): string {
  const name = tidyName(String(raw ?? ""));
  if (name === "") throw new CollegeSetupError("Enter the course name, for example Physics.");
  if (name.length > MAX_COURSE_NAME) {
    throw new CollegeSetupError(`A course name can be at most ${MAX_COURSE_NAME} characters.`);
  }
  return name;
}

/**
 * A course code, in capitals. It is also the code the course's registers and
 * the student portal show, and codes are unique across the college — two
 * courses called PHY401 would be one subject on every register.
 */
export function validateCourseCode(raw: unknown): string {
  const code = tidyName(String(raw ?? "")).toUpperCase();
  if (code === "") throw new CollegeSetupError("Enter the course code, for example PHY401.");
  if (code.length > MAX_COURSE_CODE) {
    throw new CollegeSetupError(`A course code can be at most ${MAX_COURSE_CODE} characters.`);
  }
  if (!/^[A-Z0-9][A-Z0-9./_\- ]*$/.test(code)) {
    throw new CollegeSetupError(
      "A course code can use letters, digits, spaces and the characters . / _ - only.",
    );
  }
  return code;
}

/** Which semester of the programme this is: a whole number from 1. */
export function validateSemesterNumber(raw: unknown): number {
  const text = String(raw ?? "").trim();
  const number = Number(text);
  if (text === "" || !Number.isInteger(number) || number < 1 || number > MAX_SEMESTER_NUMBER) {
    throw new CollegeSetupError(`Choose a semester number from 1 to ${MAX_SEMESTER_NUMBER}.`);
  }
  return number;
}

/** 1 → "1st", 2 → "2nd", 11 → "11th", 22 → "22nd". */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** What a semester is called when nobody typed a name: "4th Semester". */
export function defaultSemesterName(number: number): string {
  return `${ordinal(number)} Semester`;
}

/** A typed semester name, or the default for its number when the box was left empty. */
export function validateSemesterName(raw: unknown, number: number): string {
  const name = tidyName(String(raw ?? ""));
  if (name === "") return defaultSemesterName(number);
  if (name.length > MAX_SEMESTER_NAME) {
    throw new CollegeSetupError(`A semester name can be at most ${MAX_SEMESTER_NAME} characters.`);
  }
  return name;
}

export function validateSectionName(raw: unknown): string {
  const name = tidyName(String(raw ?? ""));
  if (name === "") throw new CollegeSetupError("Enter a section name, for example A.");
  if (name.length > MAX_SECTION_NAME) {
    throw new CollegeSetupError(`A section name can be at most ${MAX_SECTION_NAME} characters.`);
  }
  return name;
}

/**
 * Every section name added in one go, checked as a set: the duplicate check is
 * case-insensitive and ignores a leading "Section", and names the clash.
 */
export function validateSectionNames(raws: readonly unknown[]): string[] {
  if (raws.length === 0) throw new CollegeSetupError("Add at least one section.");
  if (raws.length > MAX_SECTIONS) {
    throw new CollegeSetupError(`A course can have at most ${MAX_SECTIONS} sections in a session.`);
  }
  const names = raws.map((raw, index) => {
    if (tidyName(String(raw ?? "")) === "") {
      throw new CollegeSetupError(`Section ${index + 1} needs a name.`);
    }
    return validateSectionName(raw);
  });
  const clashes = duplicateNames(names);
  if (clashes.length > 0) {
    throw new CollegeSetupError(
      `${clashes.map((name) => `"${name}"`).join(", ")} ${clashes.length === 1 ? "is" : "are"} ` +
        "used for more than one section. Each section needs its own name.",
    );
  }
  return names;
}

/**
 * The name a course section is known by on registers, the teacher's Attendance
 * page and reports: "PHY401-A". The course code rather than its name, because
 * codes are unique across the college and names are not — two departments
 * can each teach a "Mathematics".
 */
export function sectionGroupName(courseCode: string, sectionName: string): string {
  const code = tidyName(courseCode);
  const section = tidyName(sectionName).replace(/^section\s+/i, "");
  return /\s/.test(code) || /\s/.test(section) ? `${code} - ${section}` : `${code}-${section}`;
}

/**
 * "A", "B", … the next section names a course has not used, as suggestions
 * anyone can type over. Past Z, numbers.
 */
export function nextSectionNames(used: readonly string[], count: number): string[] {
  const taken = new Set(used.map(sectionKey));
  const names: string[] = [];
  for (let index = 0; names.length < count && index < 60; index += 1) {
    const candidate = index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
    if (!taken.has(sectionKey(candidate))) names.push(candidate);
  }
  return names;
}

/** How a section is named on its own: "Physics — Section A". */
export function sectionFullName(courseName: string, sectionLabelText: string): string {
  return `${tidyName(courseName)} — ${sectionLabelText}`;
}

/** Characters a student search needs before it looks: one letter matches half the college. */
export const MIN_STUDENT_SEARCH = 2;
/** Longer than any name or ID; refuses a pasted paragraph. */
const MAX_STUDENT_SEARCH = 80;
/** Words beyond these narrow nothing a name does not already. */
const MAX_STUDENT_SEARCH_TERMS = 4;

/**
 * A student search box as search terms, each of which has to match the
 * student ID, either name or the admission number — so "aman kum" finds Aman
 * Kumar. None until the box holds enough to search on.
 */
export function studentSearchTerms(raw: unknown): string[] {
  const text = tidyName(String(raw ?? "")).slice(0, MAX_STUDENT_SEARCH);
  if (text.length < MIN_STUDENT_SEARCH) return [];
  const terms: string[] = [];
  for (const term of text.split(" ")) {
    if (!terms.some((kept) => nameKey(kept) === nameKey(term))) terms.push(term);
  }
  return terms.slice(0, MAX_STUDENT_SEARCH_TERMS);
}

/** Whether a section's own list search finds this student: every word in their name or student ID. */
export function studentMatchesSearch(
  student: { firstName: string; lastName: string; studentCode: string },
  search: string,
): boolean {
  const haystack = nameKey(`${student.firstName} ${student.lastName} ${student.studentCode}`);
  const words = nameKey(search).split(" ").filter(Boolean);
  return words.every((word) => haystack.includes(word));
}

/** Ready, needs a teacher, or has one who can no longer sign in. */
export function sectionStatus(teacher: SectionTeacher | null): SectionStatus {
  if (!teacher) return "needs_teacher";
  return teacher.active ? "ready" : "teacher_inactive";
}

/** A course is ready once every section it has this session has a teacher who can sign in. */
export function courseStatus(sections: readonly Pick<SectionRow, "status">[]): CourseStatus {
  if (sections.length === 0) return "no_sections";
  return sections.every((section) => section.status === "ready") ? "ready" : "needs_teacher";
}

/**
 * Chooses the session a screen shows: the one asked for if it belongs to this
 * college, otherwise the current one, otherwise the most recent open one.
 */
export function pickSession<T extends { id: string; isCurrent: boolean; isActive: boolean }>(
  sessions: readonly T[],
  requested: string | undefined,
): T | null {
  if (requested) {
    const match = sessions.find((session) => session.id === requested);
    if (match) return match;
  }
  return sessions.find((session) => session.isCurrent) ?? sessions.find((session) => session.isActive) ?? null;
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en")} ${count === 1 ? one : many}`;
}

/**
 * Why a course section can or cannot be removed.
 *
 * Only a section nothing has happened in: no student ever placed, no register
 * ever taken, no elective list, no integration link. Its own course link and
 * teacher go with it. Every reason is listed at once.
 */
export function sectionRemovalCheck(
  blockers: {
    students: number;
    currentStudents: number;
    registers: number;
    subjectEnrollments: number;
    otherSubjects: number;
    externalLinks: number;
  },
  session: { name: string; isActive: boolean },
): RemovalCheck {
  const reasons: string[] = [];
  if (!session.isActive) reasons.push(`${session.name} is archived, so its sections are kept as they are.`);
  if (blockers.students > 0) {
    const still =
      blockers.currentStudents < blockers.students ? ` (${blockers.currentStudents} still in it)` : "";
    reasons.push(
      `${plural(blockers.students, "student has", "students have")} been placed in this section${still}. ` +
        "Their records stay linked to it.",
    );
  }
  if (blockers.registers > 0) {
    reasons.push(
      `Attendance has been taken for this section ${plural(blockers.registers, "time", "times")}, and attendance is never deleted.`,
    );
  }
  if (blockers.subjectEnrollments > 0) {
    reasons.push("Students have been enrolled in its course individually.");
  }
  if (blockers.otherSubjects > 0) {
    reasons.push(`${plural(blockers.otherSubjects, "other subject is", "other subjects are")} set up for it.`);
  }
  if (blockers.externalLinks > 0) {
    reasons.push("It is linked to another system through an integration. Unlink it in Integrations first.");
  }
  return { allowed: reasons.length === 0, reasons };
}

/**
 * Parses the "add by student ID" box: IDs separated by commas, spaces or new
 * lines, each once, in the order typed. "Once" means exactly as written —
 * codes are unique only as written, so two that differ in case are kept.
 */
export function parseStudentCodes(raw: unknown, max: number): string[] {
  const codes: string[] = [];
  for (const part of String(raw ?? "").split(/[\s,;]+/)) {
    const code = part.trim();
    if (code !== "" && !codes.includes(code)) codes.push(code);
  }
  if (codes.length === 0) throw new CollegeSetupError("Enter at least one student ID.");
  if (codes.length > max) {
    throw new CollegeSetupError(`Add at most ${max} students at a time.`);
  }
  return codes;
}

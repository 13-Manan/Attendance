import {
  MAX_CLASS_NAME,
  MAX_SECTIONS,
  MAX_SECTION_NAME,
  SchoolSetupError,
  type SectionStatus,
  type SectionTeacher,
} from "./types";

/**
 * What a class and its sections are allowed to be called.
 *
 * Pure, so the form can run the same checks in the browser that the server
 * runs again before writing — the browser copy is a courtesy, the server copy
 * is the rule.
 */

/** Trimmed, with runs of spaces collapsed: "Class  8 " and "Class 8" are one name. */
export function tidyName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** The comparison key. "Section a" and "SECTION A" are the same section. */
export function nameKey(raw: string): string {
  return tidyName(raw).toLocaleLowerCase("en");
}

export function sameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}

/** Section names also ignore a leading "Section": "A" and "Section A" read the same. */
export function sectionKey(raw: string): string {
  return nameKey(sectionLabel(raw));
}

export function sameSectionName(a: string, b: string): boolean {
  return sectionKey(a) === sectionKey(b);
}

export function validateClassName(raw: string): string {
  const name = tidyName(raw);
  if (name === "") throw new SchoolSetupError("Enter a class name, for example Class 8.");
  if (name.length > MAX_CLASS_NAME) {
    throw new SchoolSetupError(`A class name can be at most ${MAX_CLASS_NAME} characters.`);
  }
  return name;
}

export function validateSectionName(raw: string): string {
  const name = tidyName(raw);
  if (name === "") throw new SchoolSetupError("Enter a section name, for example A.");
  if (name.length > MAX_SECTION_NAME) {
    throw new SchoolSetupError(`A section name can be at most ${MAX_SECTION_NAME} characters.`);
  }
  return name;
}

export function validateSectionCount(count: number): number {
  if (!Number.isInteger(count) || count < 1) {
    throw new SchoolSetupError("A class needs at least one section.");
  }
  if (count > MAX_SECTIONS) {
    throw new SchoolSetupError(`A class can have at most ${MAX_SECTIONS} sections.`);
  }
  return count;
}

/**
 * Every section name for a new class, checked as a set.
 *
 * The duplicate check is case-insensitive and names the clash, because "two
 * sections have the same name" sends somebody hunting through twelve rows and
 * "A is used twice" does not.
 */
export function validateSectionNames(raws: readonly string[]): string[] {
  validateSectionCount(raws.length);
  const names = raws.map((raw, index) => {
    const name = tidyName(raw);
    if (name === "") throw new SchoolSetupError(`Section ${index + 1} needs a name.`);
    return validateSectionName(name);
  });
  const clashes = duplicateNames(names);
  if (clashes.length > 0) {
    throw new SchoolSetupError(
      `${clashes.map((name) => `"${name}"`).join(", ")} ${clashes.length === 1 ? "is" : "are"} ` +
        "used for more than one section. Each section needs its own name.",
    );
  }
  return names;
}

/** The section names that appear more than once, each reported once, in first-seen spelling. */
export function duplicateNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  const firstSpelling = new Map<string, string>();
  for (const name of names) {
    if (tidyName(name) === "") continue;
    const key = sectionKey(name);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (!firstSpelling.has(key)) firstSpelling.set(key, tidyName(name));
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([key]) => firstSpelling.get(key)!);
}

/**
 * The default names offered for section 1, 2, 3… — A, B, C… — which the
 * administrator is free to overwrite. A suggestion, never a rule: a school
 * that names its sections after rivers or colours types over them.
 */
export function suggestSectionName(index: number): string {
  if (index >= 0 && index < 26) return String.fromCharCode(65 + index);
  return String(index + 1);
}

/**
 * "Class 8" → "8", "Grade VII" → "VII", "Nursery" → "Nursery". The short form
 * a school writes on a register: 8-A rather than Class 8-A.
 */
export function shortClassLabel(className: string): string {
  const name = tidyName(className);
  const stripped = name.replace(/^(class|grade|std\.?|standard)\s+/i, "");
  return stripped === "" ? name : stripped;
}

/** "Section A" for a section called "A" — and for one already called "Section A". */
export function sectionLabel(sectionName: string): string {
  const name = tidyName(sectionName);
  return /^section\b/i.test(name) ? name : `Section ${name}`;
}

/** The group name a section is known by elsewhere in the product: "8-A". */
export function sectionGroupName(className: string, sectionName: string): string {
  const label = shortClassLabel(className);
  const section = tidyName(sectionName);
  return /\s/.test(label) || /\s/.test(section) ? `${label} - ${section}` : `${label}-${section}`;
}

/** Ready, needs a teacher, or has one who can no longer sign in. */
export function sectionStatus(teacher: SectionTeacher | null): SectionStatus {
  if (!teacher) return "needs_teacher";
  return teacher.active ? "ready" : "teacher_inactive";
}

/**
 * Chooses the year a screen should show: the one asked for if it belongs to
 * this school, otherwise the current one, otherwise the most recent open one.
 */
export function pickYear<T extends { id: string; isCurrent: boolean; isActive: boolean }>(
  years: readonly T[],
  requested: string | undefined,
): T | null {
  if (requested) {
    const match = years.find((year) => year.id === requested);
    if (match) return match;
  }
  return years.find((year) => year.isCurrent) ?? years.find((year) => year.isActive) ?? null;
}

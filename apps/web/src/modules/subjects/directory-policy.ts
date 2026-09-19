import { MAX_SUBJECT_CODE, MAX_SUBJECT_NAME, SubjectError } from "./directory-types";

/**
 * What a subject is allowed to be.
 *
 * Pure: no Prisma, no session. Every refusal is a sentence somebody can act on.
 *
 * Nothing is normalised beyond trimming — not even the code, which is tempting
 * to upper-case. "phy301" and "PHY301" look like the same subject written
 * carelessly, but the institution's own timetable is the authority on how its
 * codes are written, and rewriting one would make this screen disagree with it.
 * Uniqueness is the database's `@@unique([institutionId, code])`, which is
 * case-sensitive and therefore honest about what it enforced.
 */

function text(raw: unknown): string {
  return String(raw ?? "").trim();
}

export function validateSubjectCode(raw: unknown): string {
  const code = text(raw);
  if (code === "") {
    throw new SubjectError("Enter a code — the short form on your timetable, like PHY301.");
  }
  if (code.length > MAX_SUBJECT_CODE) {
    throw new SubjectError(`The code must be ${MAX_SUBJECT_CODE} characters or fewer.`);
  }
  return code;
}

export function validateSubjectName(raw: unknown): string {
  const name = text(raw);
  if (name === "") {
    throw new SubjectError("Enter a name — what the subject is called in full.");
  }
  if (name.length > MAX_SUBJECT_NAME) {
    throw new SubjectError(`The name must be ${MAX_SUBJECT_NAME} characters or fewer.`);
  }
  return name;
}

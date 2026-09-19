import { requirePermission } from "@/modules/authorization/service";
import type { PermissionKey } from "@/modules/authorization/permissions";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { getInstitutionType } from "@/modules/institutions/repository";
import * as repo from "./directory-repository";
import { validateSubjectCode, validateSubjectName } from "./directory-policy";
import { createSubjectForRequest, updateSubjectForRequest } from "./service";
import { SubjectError, type SubjectPage, type SubjectRow } from "./directory-types";
import type { SubjectFilters } from "./directory-filters";
import type { Subject } from "./types";

/**
 * Administering subjects.
 *
 * ## Tenancy
 *
 * No function here takes an institution id. It is read from the session, once,
 * in `requireInstitution` below, and passed to a repository whose every
 * function requires it. There is therefore no argument a caller could supply —
 * a form field, a route parameter, a crafted request body — that reaches
 * another institution's subjects. The tests assert it by counting parameters.
 *
 * ## One write path
 *
 * Nothing here writes. Creating and renaming go through `service.ts`, which
 * enforces the rule that only a college has subjects and records the audit row.
 * A second writer here would let a subject change without one.
 *
 * ## Permission
 *
 * `academicStructure.manage`, for reading as well as writing — the same gate as
 * the rest of the academic section. Faculty read the subjects they teach
 * through their classes, not through this list.
 */

export interface SubjectDirectoryDeps {
  search?: typeof repo.searchSubjects;
  get?: typeof repo.getSubjectForInstitution;
  findByCode?: typeof repo.findSubjectByCode;
  institutionType?: typeof getInstitutionType;
  create?: typeof createSubjectForRequest;
  update?: typeof updateSubjectForRequest;
}

function deps(overrides: SubjectDirectoryDeps) {
  return {
    search: overrides.search ?? repo.searchSubjects,
    get: overrides.get ?? repo.getSubjectForInstitution,
    findByCode: overrides.findByCode ?? repo.findSubjectByCode,
    institutionType: overrides.institutionType ?? getInstitutionType,
    create: overrides.create ?? createSubjectForRequest,
    update: overrides.update ?? updateSubjectForRequest,
  };
}

function requireInstitution(actor: SessionUser, permission: PermissionKey): string {
  requirePermission(actor, permission);
  if (!actor.institutionId) {
    throw new SubjectError(
      "This account is not scoped to a single institution, so it has no subjects.",
    );
  }
  return actor.institutionId;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listSubjectsForRequest(
  actor: SessionUser,
  filters: SubjectFilters,
  overrides: SubjectDirectoryDeps = {},
): Promise<SubjectPage> {
  const institutionId = requireInstitution(actor, "academicStructure.manage");
  return deps(overrides).search(institutionId, filters);
}

export async function getSubjectForRequest(
  actor: SessionUser,
  id: string,
  overrides: SubjectDirectoryDeps = {},
): Promise<SubjectRow> {
  const institutionId = requireInstitution(actor, "academicStructure.manage");
  const subject = await deps(overrides).get(institutionId, id);
  // One message for "does not exist" and "belongs to another institution".
  // Saying which would turn this page into an oracle for guessing ids.
  if (!subject) throw new SubjectError("That subject does not exist.");
  return subject;
}

/**
 * Whether this institution has subjects at all.
 *
 * A school takes one register a day for a whole class; it has no subjects, and
 * `service.ts` refuses to create one. The screens ask this so a school
 * administrator reads a sentence explaining that rather than an empty table
 * with a button that always fails.
 */
export async function subjectsApplyForRequest(
  actor: SessionUser,
  overrides: SubjectDirectoryDeps = {},
): Promise<boolean> {
  const institutionId = requireInstitution(actor, "academicStructure.manage");
  return (await deps(overrides).institutionType(institutionId)) === "COLLEGE";
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** The raw form, before any of it is trusted. */
export interface SubjectInput {
  code: unknown;
  name: unknown;
}

/**
 * Turns the subject service's coded errors into sentences.
 *
 * `subjects_are_college_only` is not a mistake the administrator made — it is
 * the domain saying a school does not have this concept — so it is phrased as
 * an explanation rather than a rejection.
 */
function describeFailure(error: unknown): never {
  if (error instanceof SubjectError) throw error;
  const code = error instanceof Error ? error.message : "";
  if (code === "subjects_are_college_only") {
    throw new SubjectError(
      "Subjects belong to colleges. A school takes one register a day for the whole class, " +
        "so there is nothing to attach a subject to.",
    );
  }
  if (code === "subject_not_found") {
    throw new SubjectError("That subject does not exist.");
  }
  throw error;
}

async function requireFreeCode(
  d: ReturnType<typeof deps>,
  institutionId: string,
  code: string,
  exceptId: string | null,
): Promise<void> {
  const clash = await d.findByCode(institutionId, code);
  if (clash && clash.id !== exceptId) {
    // Named, because the next question is "what is it?" — and the usual answer
    // is that the subject is already on the system under a code they forgot.
    throw new SubjectError(
      `${clash.code} is already used by ${clash.name}. Use a different code, or edit that subject instead.`,
    );
  }
}

export async function createSubjectFromFormForRequest(
  actor: SessionUser,
  input: SubjectInput,
  overrides: SubjectDirectoryDeps = {},
): Promise<Subject> {
  const institutionId = requireInstitution(actor, "academicStructure.manage");
  const d = deps(overrides);

  const code = validateSubjectCode(input.code);
  const name = validateSubjectName(input.name);

  await requireFreeCode(d, institutionId, code, null);

  try {
    return await d.create(actor, { institutionId, code, name });
  } catch (error) {
    describeFailure(error);
  }
}

/**
 * Rename a subject, or correct its code.
 *
 * Both are editable, unlike the academic unit's kind and parent: a subject's
 * code is a label on a timetable and nothing joins on it. What is not editable
 * is which institution it belongs to — that is not an argument here at all.
 */
export async function updateSubjectFromFormForRequest(
  actor: SessionUser,
  id: string,
  input: SubjectInput,
  overrides: SubjectDirectoryDeps = {},
): Promise<Subject> {
  const institutionId = requireInstitution(actor, "academicStructure.manage");
  const d = deps(overrides);

  // Scoped read first, so an id from another institution's URL is "does not
  // exist" here rather than a permission error from further down, which would
  // confirm the row is real.
  const existing = await d.get(institutionId, id);
  if (!existing) throw new SubjectError("That subject does not exist.");

  const code = validateSubjectCode(input.code);
  const name = validateSubjectName(input.name);

  if (code !== existing.code) await requireFreeCode(d, institutionId, code, id);

  try {
    return await d.update(actor, { id, code, name });
  } catch (error) {
    describeFailure(error);
  }
}

import { requirePermission } from "@/modules/authorization/service";
import type { PermissionKey } from "@/modules/authorization/permissions";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { getInstitutionType } from "@/modules/institutions/repository";
import { attachSubjectToCohortForRequest } from "@/modules/subjects/service";
import * as repo from "./directory-repository";
import {
  optionalId,
  requiredId,
  validateCohortName,
  validateTermLabel,
} from "./directory-policy";
import { createCohortForRequest, updateCohortForRequest } from "./service";
import type { CohortFilters } from "./directory-filters";
import {
  CohortError,
  type CohortDetail,
  type CohortFormOptions,
  type CohortPage,
} from "./directory-types";
import type { Cohort } from "./types";

/**
 * Class administration: the groups a register is taken for.
 *
 * ## Tenancy
 *
 * No function here takes an institution id. It is read from the session, once,
 * in `requireInstitution` below, and passed to a repository whose every
 * function requires it. There is therefore no argument a caller could supply —
 * a form field, a route parameter, a crafted request body — that reaches
 * another institution's classes, and with them another institution's roster.
 * The tests assert it by counting parameters.
 *
 * ## One write path
 *
 * Nothing here writes. Creating and renaming go through `service.ts`, which
 * checks that the academic unit and the academic session belong to the same
 * institution and records the audit row. Attaching a subject goes through
 * `modules/subjects/service.ts`, assigning a teacher through this module's own
 * `assignFacultyToCohortForRequest`, and removing one through
 * `modules/faculty/directory-service.ts#removeClassTeacher` — each with its own
 * tenant check and its own audit row. A second writer here would let a class
 * change without one.
 *
 * What this file adds is the layer between a form and those services: reading
 * untrusted strings, refusing them in sentences rather than in codes, and
 * assembling the several reads a screen needs into one.
 *
 * ## Permissions
 *
 * `cohort.read` to look, `cohort.manage` to create, rename or staff a class,
 * `academicStructure.manage` to attach a subject to one. All three already
 * exist and are already granted to the seeded administrator roles.
 */

export interface CohortDirectoryDeps {
  search?: typeof repo.searchCohorts;
  get?: typeof repo.getCohortForInstitution;
  listUnits?: typeof repo.listUnitChoices;
  listSessions?: typeof repo.listSessionChoices;
  listStaff?: typeof repo.listStaffChoices;
  listSubjects?: typeof repo.listSubjectChoices;
  institutionType?: typeof getInstitutionType;
  create?: typeof createCohortForRequest;
  update?: typeof updateCohortForRequest;
  attachSubject?: typeof attachSubjectToCohortForRequest;
}

function deps(overrides: CohortDirectoryDeps) {
  return {
    search: overrides.search ?? repo.searchCohorts,
    get: overrides.get ?? repo.getCohortForInstitution,
    listUnits: overrides.listUnits ?? repo.listUnitChoices,
    listSessions: overrides.listSessions ?? repo.listSessionChoices,
    listStaff: overrides.listStaff ?? repo.listStaffChoices,
    listSubjects: overrides.listSubjects ?? repo.listSubjectChoices,
    institutionType: overrides.institutionType ?? getInstitutionType,
    create: overrides.create ?? createCohortForRequest,
    update: overrides.update ?? updateCohortForRequest,
    attachSubject: overrides.attachSubject ?? attachSubjectToCohortForRequest,
  };
}

function requireInstitution(actor: SessionUser, permission: PermissionKey): string {
  requirePermission(actor, permission);
  if (!actor.institutionId) {
    throw new CohortError(
      "This account is not scoped to a single institution, so it cannot manage classes here.",
    );
  }
  return actor.institutionId;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listCohortsForRequest(
  actor: SessionUser,
  filters: CohortFilters,
  overrides: CohortDirectoryDeps = {},
): Promise<CohortPage> {
  const institutionId = requireInstitution(actor, "cohort.read");
  return deps(overrides).search(institutionId, filters);
}

export async function getCohortDetailForRequest(
  actor: SessionUser,
  id: string,
  overrides: CohortDirectoryDeps = {},
): Promise<CohortDetail> {
  const institutionId = requireInstitution(actor, "cohort.read");
  const cohort = await deps(overrides).get(institutionId, id);
  // One message for "does not exist" and "belongs to another institution".
  // Saying which would turn this page into an oracle for guessing ids.
  if (!cohort) throw new CohortError("That class does not exist.");
  return cohort;
}

/**
 * Every dropdown the list, the form and the detail page need, in one go.
 *
 * The institution type comes with them because it decides the wording — a
 * school has classes, a college has sections — and whether the subjects panel
 * exists at all.
 */
export async function getCohortFormOptionsForRequest(
  actor: SessionUser,
  overrides: CohortDirectoryDeps = {},
): Promise<CohortFormOptions> {
  const institutionId = requireInstitution(actor, "cohort.read");
  const d = deps(overrides);

  const [units, sessions, staff, type] = await Promise.all([
    d.listUnits(institutionId),
    d.listSessions(institutionId),
    d.listStaff(institutionId),
    d.institutionType(institutionId),
  ]);

  if (!type) throw new CohortError("That institution does not exist.");

  // Only a college has subjects. Asking for them at a school would always
  // return nothing, and the screen does not offer the panel either.
  const subjects = type === "COLLEGE" ? await d.listSubjects(institutionId) : [];

  return { units, sessions, staff, subjects, institutionType: type };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** The raw form, before any of it is trusted. */
export interface CohortInput {
  name: unknown;
  termLabel: unknown;
  /** Only read on create — see `updateCohortForRequest` for why. */
  academicUnitId?: unknown;
  academicSessionId?: unknown;
}

/**
 * Turns the cohort service's coded errors into sentences.
 *
 * Those codes (`cross_institution_academic_unit` and friends) are the API
 * surface's vocabulary and are load-bearing there. An administrator needs a
 * sentence, and the cross-institution ones must not be among them: saying "that
 * unit is in another institution" would confirm the id names a real row
 * somewhere else, which "does not exist" does not.
 */
function describeFailure(error: unknown): never {
  if (error instanceof CohortError) throw error;
  const code = error instanceof Error ? error.message : "";
  if (code === "academic_unit_not_found" || code === "cross_institution_academic_unit") {
    throw new CohortError("That part of the structure does not exist.");
  }
  if (code === "academic_session_not_found" || code === "cross_institution_academic_session") {
    throw new CohortError("That academic year does not exist.");
  }
  if (code === "cohort_not_found") throw new CohortError("That class does not exist.");
  if (code === "subject_not_found" || code === "cross_institution_subject") {
    throw new CohortError("That subject does not exist.");
  }
  if (code === "faculty_not_found" || code === "cross_institution_faculty") {
    throw new CohortError("That person is not a member of staff at this institution.");
  }
  throw error;
}

export async function createCohortFromFormForRequest(
  actor: SessionUser,
  input: CohortInput,
  overrides: CohortDirectoryDeps = {},
): Promise<Cohort> {
  const institutionId = requireInstitution(actor, "cohort.manage");
  const d = deps(overrides);

  const name = validateCohortName(input.name);
  const termLabel = validateTermLabel(input.termLabel);
  const academicUnitId = requiredId(
    input.academicUnitId,
    "Choose where this class sits in the structure.",
  );
  const academicSessionId = requiredId(
    input.academicSessionId,
    "Choose the academic year this class belongs to.",
  );

  try {
    return await d.create(actor, {
      institutionId,
      academicUnitId,
      academicSessionId,
      name,
      termLabel,
    });
  } catch (error) {
    describeFailure(error);
  }
}

/**
 * Rename a class, or change which part of the year it runs in.
 *
 * The academic unit and the academic year are not editable, and that is a
 * domain decision rather than an omission: they are what the class *is*, and
 * every enrollment, register and face review already points at this row on that
 * understanding. See `updateCohortForRequest`.
 */
export async function updateCohortFromFormForRequest(
  actor: SessionUser,
  id: string,
  input: CohortInput,
  overrides: CohortDirectoryDeps = {},
): Promise<Cohort> {
  const institutionId = requireInstitution(actor, "cohort.manage");
  const d = deps(overrides);

  // Scoped read first, so an id from another institution's URL is "does not
  // exist" here rather than a permission error from further down, which would
  // confirm the row is real.
  const existing = await d.get(institutionId, id);
  if (!existing) throw new CohortError("That class does not exist.");

  const name = validateCohortName(input.name);
  const termLabel = validateTermLabel(input.termLabel);

  try {
    return await d.update(actor, { cohortId: id, name, termLabel });
  } catch (error) {
    describeFailure(error);
  }
}

/**
 * Offer a subject to a class, optionally naming who teaches it.
 *
 * College only in practice — a school takes one register a day for the whole
 * class — but the refusal comes from the subject itself: a school has no
 * subjects to attach, so the dropdown is empty and the panel is not rendered.
 */
export async function attachSubjectForRequest(
  actor: SessionUser,
  params: { cohortId: string; subjectId: unknown; facultyId: unknown },
  overrides: CohortDirectoryDeps = {},
): Promise<{ cohortName: string }> {
  const institutionId = requireInstitution(actor, "academicStructure.manage");
  const d = deps(overrides);

  const cohort = await d.get(institutionId, params.cohortId);
  if (!cohort) throw new CohortError("That class does not exist.");

  const subjectId = requiredId(params.subjectId, "Choose a subject.");
  const facultyId = optionalId(params.facultyId);

  // Checked here as well as by the unique constraint, so the second submission
  // of a double-clicked form is a sentence naming the subject rather than a
  // constraint violation.
  const existing = cohort.subjects.find((offering) => offering.subjectId === subjectId);
  if (existing) {
    throw new CohortError(`${existing.code} is already offered to ${cohort.name}.`);
  }

  try {
    await d.attachSubject(actor, { cohortId: params.cohortId, subjectId, facultyId });
  } catch (error) {
    describeFailure(error);
  }

  return { cohortName: cohort.name };
}

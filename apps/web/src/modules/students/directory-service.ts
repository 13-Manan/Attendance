import { requirePermission } from "@/modules/authorization/service";
import type { PermissionKey } from "@/modules/authorization/permissions";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import {
  enrollStudentInCohortForRequest,
  unenrollStudentFromCohortForRequest,
} from "@/modules/enrollment/service";
import * as repo from "./directory-repository";
import {
  optionalId,
  parseAdmissionDate,
  validateAdmissionNumber,
  validateStudentCode,
  validateStudentEmail,
  validateStudentName,
  validateStudentPhone,
  validateStudentStatus,
} from "./directory-policy";
import { createStudent, updateStudent } from "./service";
import type { StudentFilters } from "./directory-filters";
import {
  STUDENT_STATUS_LABEL,
  StudentError,
  type StudentDetail,
  type StudentFormOptions,
  type StudentPage,
  type StudentStatus,
} from "./directory-types";
import { studentDisplayName, type Student } from "./types";

/**
 * Student administration.
 *
 * ## Tenancy
 *
 * No function here takes an institution id. It is read from the session, once,
 * in `requireInstitution` below, and passed to a repository whose every
 * function requires it. There is therefore no argument a caller could supply —
 * a form field, a route parameter, a crafted request body — that reaches
 * another institution's students. The brief's "a user from Institution A must
 * never access Institution B's students" is a property of the module's shape
 * rather than a check somebody has to remember to write, and the tests assert
 * it by counting parameters.
 *
 * ## One write path
 *
 * Nothing here writes to the `Student` table. Creating and updating go through
 * `service.ts`, which is the single write path: it opens the transaction, it
 * writes the audit row inside it, and it emits the webhook after it. A second
 * writer here would let a student record change without either, and the
 * integration contract ("every student change is delivered") would quietly
 * stop being true for exactly the changes an administrator makes by hand.
 *
 * Placement in a class goes through `modules/enrollment/service.ts` for the
 * same reason — it is the only writer of `Enrollment`, and the guard that a
 * student and a cohort belong to the same institution lives inside it.
 *
 * ## Permissions
 *
 * `student.read` to look, `student.create` to admit, `student.update` to edit
 * or archive, `enrollment.manage` to place into a class. All four already
 * exist and are already granted to the seeded administrator roles; this phase
 * gives them screens rather than inventing keys nobody's database has.
 */

export interface StudentDirectoryDeps {
  search?: typeof repo.searchStudents;
  get?: typeof repo.getStudentForInstitution;
  findByCode?: typeof repo.findStudentByCode;
  listCohorts?: typeof repo.listCohortChoices;
  listCampuses?: typeof repo.listCampusChoices;
  findCohort?: typeof repo.findCohortForInstitution;
  findCampus?: typeof repo.findCampusForInstitution;
  create?: typeof createStudent;
  update?: typeof updateStudent;
  enroll?: typeof enrollStudentInCohortForRequest;
  unenroll?: typeof unenrollStudentFromCohortForRequest;
  now?: () => Date;
}

function deps(overrides: StudentDirectoryDeps) {
  return {
    search: overrides.search ?? repo.searchStudents,
    get: overrides.get ?? repo.getStudentForInstitution,
    findByCode: overrides.findByCode ?? repo.findStudentByCode,
    listCohorts: overrides.listCohorts ?? repo.listCohortChoices,
    listCampuses: overrides.listCampuses ?? repo.listCampusChoices,
    findCohort: overrides.findCohort ?? repo.findCohortForInstitution,
    findCampus: overrides.findCampus ?? repo.findCampusForInstitution,
    create: overrides.create ?? createStudent,
    update: overrides.update ?? updateStudent,
    enroll: overrides.enroll ?? enrollStudentInCohortForRequest,
    unenroll: overrides.unenroll ?? unenrollStudentFromCohortForRequest,
    now: overrides.now ?? (() => new Date()),
  };
}

function requireInstitution(actor: SessionUser, permission: PermissionKey): string {
  requirePermission(actor, permission);
  if (!actor.institutionId) {
    throw new StudentError(
      "This account is not scoped to a single institution, so it cannot manage students here.",
    );
  }
  return actor.institutionId;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listStudentsForRequest(
  actor: SessionUser,
  filters: StudentFilters,
  overrides: StudentDirectoryDeps = {},
): Promise<StudentPage> {
  const institutionId = requireInstitution(actor, "student.read");
  return deps(overrides).search(institutionId, filters);
}

export async function getStudentForRequest(
  actor: SessionUser,
  id: string,
  overrides: StudentDirectoryDeps = {},
): Promise<StudentDetail> {
  const institutionId = requireInstitution(actor, "student.read");
  const student = await deps(overrides).get(institutionId, id);
  // One message for "does not exist" and "belongs to another institution".
  // Saying which would turn this page into an oracle for guessing ids.
  if (!student) throw new StudentError("That student does not exist.");
  return student;
}

/** The dropdowns the directory and its forms need, in one round trip. */
export async function getStudentFormOptionsForRequest(
  actor: SessionUser,
  overrides: StudentDirectoryDeps = {},
): Promise<StudentFormOptions> {
  const institutionId = requireInstitution(actor, "student.read");
  const d = deps(overrides);
  const [campuses, cohorts] = await Promise.all([
    d.listCampuses(institutionId),
    d.listCohorts(institutionId),
  ]);
  return { campuses, cohorts };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** The raw form, before any of it is trusted. */
export interface StudentInput {
  studentCode: unknown;
  firstName: unknown;
  lastName: unknown;
  email: unknown;
  phone: unknown;
  campusId: unknown;
  admissionNumber: unknown;
  admissionDate: unknown;
  /** Only read on edit. A new student is on roll by definition. */
  status?: unknown;
  /** Only read on create: the class to place them in straight away. */
  cohortId?: unknown;
}

interface ValidatedStudent {
  studentCode: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  campusId: string | null;
  admissionNumber: string | null;
  admissionDate: Date | null;
}

function validate(input: StudentInput, now: Date): ValidatedStudent {
  return {
    studentCode: validateStudentCode(input.studentCode),
    firstName: validateStudentName(input.firstName, "first name"),
    lastName: validateStudentName(input.lastName, "last name"),
    email: validateStudentEmail(input.email),
    phone: validateStudentPhone(input.phone),
    campusId: optionalId(input.campusId),
    admissionNumber: validateAdmissionNumber(input.admissionNumber),
    admissionDate: parseAdmissionDate(input.admissionDate, now),
  };
}

/**
 * A campus id from a form is only a string until this says otherwise.
 *
 * A closed campus is allowed: it still has students whose records need
 * correcting, and refusing one would mean an administrator could not fix a
 * typo on a child at a branch that shut last year.
 */
async function resolveCampus(
  institutionId: string,
  campusId: string | null,
  find: typeof repo.findCampusForInstitution,
): Promise<string | null> {
  if (campusId === null) return null;
  const campus = await find(institutionId, campusId);
  if (!campus) throw new StudentError("That campus does not exist.");
  return campus.id;
}

export async function createStudentForRequest(
  actor: SessionUser,
  input: StudentInput,
  overrides: StudentDirectoryDeps = {},
): Promise<Student> {
  const institutionId = requireInstitution(actor, "student.create");
  const d = deps(overrides);

  const cohortId = optionalId(input.cohortId);
  // Checked before anything is validated or written: placing a student in a
  // class is a second permission, and an administrator who lacks it should be
  // told so rather than having a student created and the placement silently
  // dropped.
  if (cohortId !== null) requirePermission(actor, "enrollment.manage");

  const values = validate(input, d.now());
  const campusId = await resolveCampus(institutionId, values.campusId, d.findCampus);

  const clash = await d.findByCode(institutionId, values.studentCode);
  if (clash) {
    // Named, because the clerk's next question is "whose is it?" — and the
    // usual answer is that this student is already on the system.
    throw new StudentError(
      `Student code "${values.studentCode}" already belongs to ${studentDisplayName(clash)}. ` +
        "Use a different code, or edit that record instead.",
    );
  }

  // The class is confirmed to be this institution's before the student is
  // created, so the only way the placement below can fail is a database
  // failure — not a mistyped id leaving a new student unplaced with an error
  // message that says nothing was created.
  if (cohortId !== null) {
    const cohort = await d.findCohort(institutionId, cohortId);
    if (!cohort) throw new StudentError("That class does not exist.");
  }

  const student = await d.create(actor, {
    institutionId,
    campusId,
    studentCode: values.studentCode,
    firstName: values.firstName,
    lastName: values.lastName,
    email: values.email,
    phone: values.phone,
    admissionNumber: values.admissionNumber,
    admissionDate: values.admissionDate,
  });

  if (cohortId !== null) {
    await d.enroll(actor, { studentId: student.id, cohortId });
  }

  return student;
}

export async function updateStudentForRequest(
  actor: SessionUser,
  id: string,
  input: StudentInput,
  overrides: StudentDirectoryDeps = {},
): Promise<Student> {
  const institutionId = requireInstitution(actor, "student.update");
  const d = deps(overrides);

  // Scoped read first, so an id from another institution's URL is "does not
  // exist" here rather than a permission error from further down, which would
  // confirm the row is real.
  const existing = await d.get(institutionId, id);
  if (!existing) throw new StudentError("That student does not exist.");

  const values = validate(input, d.now());
  const status =
    input.status === undefined ? existing.status : validateStudentStatus(input.status);
  const campusId = await resolveCampus(institutionId, values.campusId, d.findCampus);

  if (values.studentCode !== existing.studentCode) {
    const clash = await d.findByCode(institutionId, values.studentCode);
    if (clash && clash.id !== id) {
      throw new StudentError(
        `Student code "${values.studentCode}" already belongs to ${studentDisplayName(clash)}. ` +
          "Use a different code.",
      );
    }
  }

  return d.update(actor, {
    studentId: id,
    studentCode: values.studentCode,
    firstName: values.firstName,
    lastName: values.lastName,
    email: values.email,
    phone: values.phone,
    campusId,
    admissionNumber: values.admissionNumber,
    admissionDate: values.admissionDate,
    status,
  });
}

/**
 * Archive a student, or bring one back.
 *
 * One function for both directions, because it is one decision with a sign,
 * and the audit action is derived from the transition down in `service.ts`
 * rather than chosen by the caller — an action name a caller could pick is a
 * log a caller could mislead.
 *
 * A student is never deleted. Every register they appeared in names them, and
 * a register that lost its students would stop being evidence of anything.
 * Archiving takes them off new class lists and leaves all of that intact.
 *
 * Setting the status it already has is refused rather than treated as success:
 * a double-submitted button is harmless, but a second audit row saying a child
 * left on a day they did not is not.
 */
export async function setStudentStatusForRequest(
  actor: SessionUser,
  id: string,
  status: unknown,
  overrides: StudentDirectoryDeps = {},
): Promise<Student> {
  const institutionId = requireInstitution(actor, "student.update");
  const d = deps(overrides);

  const existing = await d.get(institutionId, id);
  if (!existing) throw new StudentError("That student does not exist.");

  const next = validateStudentStatus(status);
  if (existing.status === next) {
    throw new StudentError(
      `${studentDisplayName(existing)} is already ${STUDENT_STATUS_LABEL[next].toLowerCase()}.`,
    );
  }

  return d.update(actor, { studentId: id, status: next });
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * Turns the enrollment service's coded errors into sentences.
 *
 * Those codes (`cohort_not_found`, `cross_institution_enrollment`) are the API
 * surface's vocabulary and are load-bearing there. A person looking at a
 * student's record needs a sentence, and `cross_institution_enrollment` must
 * not be one of them — it would confirm that the id names a real class
 * somewhere else.
 */
function describePlacementFailure(error: unknown): never {
  if (error instanceof StudentError) throw error;
  const code = error instanceof Error ? error.message : "";
  if (code === "student_not_found") throw new StudentError("That student does not exist.");
  if (code === "cohort_not_found" || code === "cross_institution_enrollment") {
    throw new StudentError("That class does not exist.");
  }
  if (code === "enrollment_not_found") {
    throw new StudentError("That student is not in that class.");
  }
  throw error;
}

export async function assignStudentToClassForRequest(
  actor: SessionUser,
  params: { studentId: string; cohortId: string },
  overrides: StudentDirectoryDeps = {},
): Promise<{ cohortName: string }> {
  const institutionId = requireInstitution(actor, "enrollment.manage");
  const d = deps(overrides);

  const student = await d.get(institutionId, params.studentId);
  if (!student) throw new StudentError("That student does not exist.");

  const cohort = await d.findCohort(institutionId, params.cohortId);
  if (!cohort) throw new StudentError("That class does not exist.");

  if (student.classes.some((link) => link.cohortId === cohort.id)) {
    throw new StudentError(`${studentDisplayName(student)} is already in ${cohort.name}.`);
  }

  // Archived students are not refused — a student who transferred back in is
  // restored and placed in the same sitting, and the order the clerk does it
  // in should not matter. What the screen does instead is say so.
  try {
    await d.enroll(actor, { studentId: params.studentId, cohortId: params.cohortId });
  } catch (error) {
    describePlacementFailure(error);
  }

  return { cohortName: cohort.name };
}

export async function removeStudentFromClassForRequest(
  actor: SessionUser,
  params: { studentId: string; cohortId: string },
  overrides: StudentDirectoryDeps = {},
): Promise<{ cohortName: string }> {
  const institutionId = requireInstitution(actor, "enrollment.manage");
  const d = deps(overrides);

  const student = await d.get(institutionId, params.studentId);
  if (!student) throw new StudentError("That student does not exist.");

  const cohort = await d.findCohort(institutionId, params.cohortId);
  if (!cohort) throw new StudentError("That class does not exist.");

  try {
    await d.unenroll(actor, { studentId: params.studentId, cohortId: params.cohortId });
  } catch (error) {
    describePlacementFailure(error);
  }

  return { cohortName: cohort.name };
}

/** Re-exported so callers need one import for the status vocabulary. */
export type { StudentStatus };

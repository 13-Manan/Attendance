import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/modules/authorization/service";
import type { PermissionKey } from "@/modules/authorization/permissions";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import {
  enrollStudentInCohortForRequest,
  enrollStudentInCohortWithin,
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
import {
  STUDENT_TEMP_PASSWORD_NOTICE,
  createStudentLoginWithin,
  issueTemporaryPassword,
  prepareLogin,
  requireEmail,
  requireStudentPasswordStorage,
  type ProvisionedStudentLogin,
} from "./login-provisioning";
import {
  announceStudentCreated,
  createStudent,
  createStudentWithin,
  updateStudent,
  type CreateStudentInput,
} from "./service";
import type { StudentFilters } from "./directory-filters";
import type { FaceModelFilter } from "./verification";
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
 * A student admitted together with their login is the one place this module
 * opens a transaction: it holds it while those three writers — the student,
 * the placement, the login — each write their own rows and audit rows in it,
 * so that all of it commits, or none of it.
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
  runningFaceModel?: () => Promise<FaceModelFilter>;
  get?: typeof repo.getStudentForInstitution;
  findByCode?: typeof repo.findStudentByCode;
  listCohorts?: typeof repo.listCohortChoices;
  listCampuses?: typeof repo.listCampusChoices;
  findCohort?: typeof repo.findCohortForInstitution;
  findCampus?: typeof repo.findCampusForInstitution;
  findByEmail?: typeof repo.findStudentByEmail;
  create?: typeof createStudent;
  update?: typeof updateStudent;
  enroll?: typeof enrollStudentInCohortForRequest;
  unenroll?: typeof unenrollStudentFromCohortForRequest;
  now?: () => Date;
}

function deps(overrides: StudentDirectoryDeps) {
  return {
    search: overrides.search ?? repo.searchStudents,
    runningFaceModel: overrides.runningFaceModel ?? (async () => (await import("./verification-service")).runningFaceModel()),
    get: overrides.get ?? repo.getStudentForInstitution,
    findByCode: overrides.findByCode ?? repo.findStudentByCode,
    listCohorts: overrides.listCohorts ?? repo.listCohortChoices,
    listCampuses: overrides.listCampuses ?? repo.listCampusChoices,
    findCohort: overrides.findCohort ?? repo.findCohortForInstitution,
    findCampus: overrides.findCampus ?? repo.findCampusForInstitution,
    findByEmail: overrides.findByEmail ?? repo.findStudentByEmail,
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
  const d = deps(overrides);
  // The verification filter and the "incomplete" count both count a face
  // only when the running model made it, as the badges on the rows do.
  const faceModel = await d.runningFaceModel();
  return d.search(institutionId, filters, undefined, undefined, { faceModel });
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
  const d = deps(overrides);
  const { cohortId, data } = await prepareNewStudent(actor, input, d);

  const student = await d.create(actor, data);

  if (cohortId !== null) {
    await d.enroll(actor, { studentId: student.id, cohortId });
  }

  return student;
}

/**
 * Everything a new student is checked for before anything is written, in
 * order: the permissions, the fields, the campus, a code no other student
 * has, a class of this institution. Shared by both ways of admitting a
 * student, so neither accepts what the other refuses.
 */
async function prepareNewStudent(
  actor: SessionUser,
  input: StudentInput,
  d: ReturnType<typeof deps>,
): Promise<{ institutionId: string; cohortId: string | null; data: CreateStudentInput }> {
  const institutionId = requireInstitution(actor, "student.create");

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

  return {
    institutionId,
    cohortId,
    data: {
      institutionId,
      campusId,
      studentCode: values.studentCode,
      firstName: values.firstName,
      lastName: values.lastName,
      email: values.email,
      phone: values.phone,
      admissionNumber: values.admissionNumber,
      admissionDate: values.admissionDate,
    },
  };
}

export interface StudentWithLogin {
  student: Student;
  login: ProvisionedStudentLogin;
}

/**
 * A new student and their Student Portal login, admitted in one step: the
 * record, their place in a class, the account with its one STUDENT role, and
 * the audit rows of all three commit together or not at all. A refusal — or a
 * failure part-way — leaves nothing behind: never a student without the login
 * they were admitted with, nor a login without its student.
 *
 * The email is required here, as it is not on the plain Add student form: it
 * is the address the student signs in with, so it is both the record's email
 * and the account's. It must be a real address, belong to no account, and not
 * be another student's here already — that would be the same person admitted
 * twice. Every other field passes exactly the plain form's checks.
 *
 * The temporary password comes back once, for whoever admitted the student to
 * hand over. Only its hash is stored, and the account must replace it at the
 * first sign-in.
 */
export async function createStudentWithLoginForRequest(
  actor: SessionUser,
  input: StudentInput,
  overrides: StudentDirectoryDeps = {},
): Promise<StudentWithLogin> {
  const d = deps(overrides);
  // Checked before anything else, like the class's permission: creating an
  // account is part of what was asked, so lacking it refuses the whole step.
  requirePermission(actor, "user.invite");
  const { institutionId, cohortId, data } = await prepareNewStudent(actor, input, d);
  if (cohortId === null) throw new StudentError("Choose the class they join.");
  if (!data.email) {
    throw new StudentError("Enter the student's college email. It is what they sign in to the Student Portal with.");
  }
  const email = requireEmail(data.email);
  if (await d.findByEmail(institutionId, email)) {
    throw new StudentError(
      "Another student already has this email. If this is the same student, use “Add existing student” instead of admitting them again.",
    );
  }
  const roleId = await prepareLogin(email);
  requireStudentPasswordStorage("admit");
  const { password, passwordHash } = await issueTemporaryPassword();

  let created: { student: Student; userId: string };
  try {
    created = await prisma.$transaction(
      async (tx) => {
        const student = await createStudentWithin(tx, actor, { ...data, email });
        await enrollStudentInCohortWithin(tx, actor, { studentId: student.id, cohortId });
        const userId = await createStudentLoginWithin(tx, actor, {
          institutionId,
          roleId,
          student,
          email,
          realEmail: email,
          password,
          passwordHash,
        });
        return { student, userId };
      },
      { timeout: 20_000 },
    );
  } catch (error) {
    throw uniqueConflict(error, { email, studentCode: data.studentCode }) ?? error;
  }

  announceStudentCreated(created.student);
  return {
    student: created.student,
    login: {
      account: {
        userId: created.userId,
        loginId: created.student.studentCode,
        email,
        status: "ACTIVE",
        studentOnRoll: true,
        lastLoginAt: null,
        institutionId,
        mustChangePassword: true,
        lastPasswordChange: { at: created.student.createdAt, by: "staff" },
        passwordRecoverable: true,
      },
      password,
      notice: STUDENT_TEMP_PASSWORD_NOTICE,
    },
  };
}

/**
 * The checks above run before the transaction, so two people admitting the
 * same student at the same moment can both pass them; the unique indexes are
 * what stop the second, and its whole transaction rolls back. Said in the
 * words the checks would have used.
 */
function uniqueConflict(error: unknown, attempted: { email: string; studentCode: string }): StudentError | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return null;
  const target = JSON.stringify(error.meta?.target ?? "");
  if (target.includes("email")) {
    return new StudentError(`An account already uses ${attempted.email}. An address can only belong to one account.`);
  }
  if (target.includes("studentCode")) {
    return new StudentError(`Student code "${attempted.studentCode}" was just given to another student. Use a different code.`);
  }
  return new StudentError("Somebody else changed this student at the same moment. Nothing was saved; try again.");
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

"use server";

/**
 * Server Actions for the college setup screens.
 *
 * A boundary only: resolve the session user, read the form, call the service,
 * shape the result for the page. Authorization, department scope, tenancy,
 * validation and audit all happen in `service.ts`; no action here takes an
 * institution id, and every id it forwards is checked there again.
 *
 * A temporary password returned here goes to the browser that submitted the
 * form and nowhere else — the same lifetime as on the Faculty page.
 */

import { z } from "zod";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { imageBase64Field } from "@/lib/image-validation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import type { FaceEnrollmentResult } from "@/modules/face-enrollment/types";
import { FacultyError } from "@/modules/faculty/directory-types";
import type { StudentFormValues } from "@/modules/students/directory-actions";
import { StudentError } from "@/modules/students/directory-types";
import { sectionLabel } from "./policy";
import {
  addCourseSections,
  addDepartmentFaculty,
  addStudentToDepartmentSection,
  addStudentToSection,
  addStudentsToSection,
  assignDepartmentHead,
  assignFacultyToSection,
  createCourse,
  createDepartment,
  createDepartmentHead,
  createDepartmentStudent,
  createDepartmentStudentLogin,
  createSemester,
  enrollDepartmentStudentFace,
  inviteTeacherForCourseSection,
  removeCourse,
  removeCourseSection,
  removeCourseSectionTeacher,
  removeDepartmentHead,
  removeSemester,
  removeStudentFromDepartmentSection,
  removeStudentFromSection,
  renameCourseSection,
  resetDepartmentHeadPassword,
  resetDepartmentStudentPassword,
  setCourseSectionTeacher,
  setCurrentSemester,
  setDepartmentFacultyActive,
  setDepartmentHeadActive,
  updateCourse,
  updateDepartment,
  updateDepartmentFacultyMember,
  updateSemester,
} from "./service";
import { CollegeSetupError, SameCourseConflict } from "./types";

export interface CollegeActionState {
  error?: string;
  message?: string;
  /** Further lines under the message: which students were added, which were not and why. */
  details?: string[];
  /** Shown once, immediately after it is issued. Never re-readable. */
  password?: string;
  passwordLabel?: string;
  /** What the person the password is for can do with it — it differs between a head and a teacher. */
  passwordNote?: string;
  /** The account a form has just created, for the next step it offers. */
  createdId?: string;
  /**
   * The student is in another section of this course already: where, so the
   * form can offer the one deliberate answer — moving them.
   */
  conflict?: { sectionId: string; label: string };
  /** Changes on every submission, so a form can reset itself after a success. */
  attempt?: number;
  /** What was typed, echoed back on a refusal so the form does not clear itself. */
  values?: Record<string, string>;
}

const BASE = "/dashboard/college/departments";

function describe(error: unknown, fallback: string): string {
  if (error instanceof CollegeSetupError || error instanceof FacultyError || error instanceof StudentError) {
    return error.message;
  }
  if (error instanceof ForbiddenError) return "You do not have access to change this.";
  return fallback;
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "");
}

function next(prev: { attempt?: number }): number {
  return (prev.attempt ?? 0) + 1;
}

function sectionIds(formData: FormData) {
  return {
    departmentId: text(formData, "departmentId"),
    semesterId: text(formData, "semesterId"),
    courseId: text(formData, "courseId"),
    sectionId: text(formData, "sectionId"),
  };
}

function sectionPath(ids: ReturnType<typeof sectionIds>): string {
  return `${BASE}/${encodeURIComponent(ids.departmentId)}/semesters/${encodeURIComponent(ids.semesterId)}/courses/${encodeURIComponent(ids.courseId)}/sections/${encodeURIComponent(ids.sectionId)}`;
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export async function createDepartmentAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  let created: { departmentId: string };
  try {
    created = await createDepartment(actor, { name: text(formData, "name"), code: text(formData, "code") });
  } catch (error) {
    return {
      error: describe(error, "The department could not be created."),
      values: { name: text(formData, "name"), code: text(formData, "code") },
      attempt: next(prev),
    };
  }
  redirect(`${BASE}/${created.departmentId}?created=1`);
}

export async function updateDepartmentAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  try {
    const { name } = await updateDepartment(actor, {
      departmentId: text(formData, "departmentId"),
      name: text(formData, "name"),
      code: text(formData, "code"),
    });
    refresh();
    return { message: `Saved. The department is now ${name}.`, attempt: next(prev) };
  } catch (error) {
    return {
      error: describe(error, "The department could not be saved."),
      values: { name: text(formData, "name"), code: text(formData, "code") },
      attempt: next(prev),
    };
  }
}

// ---------------------------------------------------------------------------
// Head of department
// ---------------------------------------------------------------------------

export async function assignHeadAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  try {
    const { name, replaced } = await assignDepartmentHead(actor, {
      departmentId: text(formData, "departmentId"),
      userId: text(formData, "userId"),
    });
    refresh();
    return {
      message: `${name} is now head of department.${replaced ? ` ${replaced} is back to an ordinary teaching role.` : ""} They keep their login and password.`,
      attempt: next(prev),
    };
  } catch (error) {
    return { error: describe(error, "The head of department could not be changed."), attempt: next(prev) };
  }
}

export async function createHeadAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  const values = {
    name: text(formData, "name"),
    email: text(formData, "email"),
    employeeCode: text(formData, "employeeCode"),
  };
  try {
    const { invited, assignError } = await createDepartmentHead(actor, {
      departmentId: text(formData, "departmentId"),
      ...values,
    });
    refresh();
    return {
      message: assignError
        ? `${invited.member.name}'s account was created, but they could not be made head: ${assignError}`
        : `${invited.member.name} is now head of department and can sign in with ${invited.member.email}.`,
      password: invited.password,
      passwordLabel: `Temporary password for ${invited.member.email}`,
      attempt: next(prev),
    };
  } catch (error) {
    return { error: describe(error, "The account could not be created."), values, attempt: next(prev) };
  }
}

/** Removing the head removes the controls that asked, so the department page says so itself. */
export async function removeHeadAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  const departmentId = text(formData, "departmentId");
  let name: string | null;
  try {
    ({ name } = await removeDepartmentHead(actor, departmentId));
  } catch (error) {
    return { error: describe(error, "The head of department could not be removed."), attempt: next(prev) };
  }
  redirect(`${BASE}/${encodeURIComponent(departmentId)}?headRemoved=${encodeURIComponent(name ?? "The head")}`);
}

export async function resetHeadPasswordAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  try {
    const issued = await resetDepartmentHeadPassword(actor, text(formData, "departmentId"));
    refresh();
    return {
      message: `${issued.name}'s old password has stopped working, and they have been signed out everywhere.`,
      password: issued.password,
      passwordLabel: `New temporary password for ${issued.name}`,
      attempt: next(prev),
    };
  } catch (error) {
    return { error: describe(error, "A new password could not be issued."), attempt: next(prev) };
  }
}

export async function setHeadActiveAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  const active = text(formData, "active") === "1";
  try {
    const { name } = await setDepartmentHeadActive(actor, text(formData, "departmentId"), active);
    refresh();
    return {
      message: active ? `${name} can sign in again.` : `${name} can no longer sign in, and has been signed out everywhere.`,
      attempt: next(prev),
    };
  } catch (error) {
    return { error: describe(error, "The account could not be changed."), attempt: next(prev) };
  }
}

// ---------------------------------------------------------------------------
// Semesters
// ---------------------------------------------------------------------------

export async function createSemesterAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  try {
    const { name } = await createSemester(actor, {
      departmentId: text(formData, "departmentId"),
      number: text(formData, "number"),
      name: text(formData, "name"),
    });
    refresh();
    return { message: `${name} added.`, attempt: next(prev) };
  } catch (error) {
    return {
      error: describe(error, "The semester could not be added."),
      values: { number: text(formData, "number"), name: text(formData, "name") },
      attempt: next(prev),
    };
  }
}

export async function updateSemesterAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  try {
    const { name } = await updateSemester(actor, {
      departmentId: text(formData, "departmentId"),
      semesterId: text(formData, "semesterId"),
      number: text(formData, "number"),
      name: text(formData, "name"),
    });
    refresh();
    return { message: `Saved as ${name}.`, attempt: next(prev) };
  } catch (error) {
    return {
      error: describe(error, "The semester could not be saved."),
      values: { number: text(formData, "number"), name: text(formData, "name") },
      attempt: next(prev),
    };
  }
}

export async function setCurrentSemesterAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  try {
    const { name } = await setCurrentSemester(actor, {
      departmentId: text(formData, "departmentId"),
      semesterId: text(formData, "semesterId"),
    });
    refresh();
    return { message: name ? `${name} is now the current semester.` : "No semester is marked current.", attempt: next(prev) };
  } catch (error) {
    return { error: describe(error, "The current semester could not be changed."), attempt: next(prev) };
  }
}

export async function removeSemesterAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  const departmentId = text(formData, "departmentId");
  let name: string;
  try {
    ({ name } = await removeSemester(actor, { departmentId, semesterId: text(formData, "semesterId") }));
  } catch (error) {
    return { error: describe(error, "The semester could not be removed."), attempt: next(prev) };
  }
  redirect(`${BASE}/${encodeURIComponent(departmentId)}?removed=${encodeURIComponent(name)}`);
}

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

/**
 * Adds a course. The semester page sends its department and semester; the
 * Courses page sends only the chosen semester, and the service finds — and
 * checks — its department.
 */
export async function createCourseAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  const session = text(formData, "sessionId");
  let created: { courseId: string; departmentId: string; semesterId: string };
  try {
    created = await createCourse(actor, {
      departmentId: text(formData, "departmentId") || undefined,
      semesterId: text(formData, "semesterId"),
      code: text(formData, "code"),
      name: text(formData, "name"),
    });
  } catch (error) {
    return {
      error: describe(error, "The course could not be added."),
      values: { code: text(formData, "code"), name: text(formData, "name"), semesterId: text(formData, "semesterId") },
      attempt: next(prev),
    };
  }
  const query = new URLSearchParams({ created: "1", ...(session ? { session } : {}) });
  redirect(
    `${BASE}/${encodeURIComponent(created.departmentId)}/semesters/${encodeURIComponent(created.semesterId)}/courses/${encodeURIComponent(created.courseId)}?${query}`,
  );
}

export async function updateCourseAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  try {
    const { name } = await updateCourse(actor, {
      departmentId: text(formData, "departmentId"),
      semesterId: text(formData, "semesterId"),
      courseId: text(formData, "courseId"),
      code: text(formData, "code"),
      name: text(formData, "name"),
      sessionId: text(formData, "sessionId"),
    });
    refresh();
    return { message: `Saved as ${name}.`, attempt: next(prev) };
  } catch (error) {
    return {
      error: describe(error, "The course could not be saved."),
      values: { code: text(formData, "code"), name: text(formData, "name") },
      attempt: next(prev),
    };
  }
}

export async function removeCourseAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  const departmentId = text(formData, "departmentId");
  const semesterId = text(formData, "semesterId");
  let name: string;
  try {
    ({ name } = await removeCourse(actor, { departmentId, semesterId, courseId: text(formData, "courseId") }));
  } catch (error) {
    return { error: describe(error, "The course could not be removed."), attempt: next(prev) };
  }
  redirect(
    `${BASE}/${encodeURIComponent(departmentId)}/semesters/${encodeURIComponent(semesterId)}?removed=${encodeURIComponent(name)}`,
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export async function addSectionsAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  const names = formData.getAll("sectionName").map(String);
  const teachers = formData.getAll("teacherId").map(String);
  try {
    const result = await addCourseSections(actor, {
      departmentId: text(formData, "departmentId"),
      semesterId: text(formData, "semesterId"),
      courseId: text(formData, "courseId"),
      sessionId: text(formData, "sessionId"),
      sections: names.map((name, index) => ({ name, teacherId: teachers[index] ?? "" })),
    });
    refresh();
    return {
      message: `${result.names.map(sectionLabel).join(", ")} added.`,
      attempt: next(prev),
    };
  } catch (error) {
    return {
      error: describe(error, "The section could not be added."),
      values: { sectionName: names[0] ?? "", teacherId: teachers[0] ?? "" },
      attempt: next(prev),
    };
  }
}

export async function renameSectionAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  try {
    const { name } = await renameCourseSection(actor, { ...sectionIds(formData), name: text(formData, "name") });
    refresh();
    return { message: `Renamed to ${sectionLabel(name)}.`, attempt: next(prev) };
  } catch (error) {
    return {
      error: describe(error, "The section could not be renamed."),
      values: { name: text(formData, "name") },
      attempt: next(prev),
    };
  }
}

export async function removeSectionAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  const ids = sectionIds(formData);
  let name: string;
  try {
    ({ name } = await removeCourseSection(actor, ids));
  } catch (error) {
    return { error: describe(error, "The section could not be removed."), attempt: next(prev) };
  }
  redirect(
    `${BASE}/${encodeURIComponent(ids.departmentId)}/semesters/${encodeURIComponent(ids.semesterId)}/courses/${encodeURIComponent(ids.courseId)}?removed=${encodeURIComponent(name)}`,
  );
}

export async function setSectionTeacherAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  try {
    const { teacherName, replaced } = await setCourseSectionTeacher(actor, {
      ...sectionIds(formData),
      teacherId: text(formData, "teacherId"),
      // The teacher the form showed; a section that has changed hands since is not changed again blindly.
      expectedTeacherId: formData.has("expectedTeacherId") ? text(formData, "expectedTeacherId") : undefined,
    });
    refresh();
    return {
      message: `${teacherName} now teaches this section.${replaced.length ? ` ${replaced.join(", ")} no longer does.` : ""}`,
      attempt: next(prev),
    };
  } catch (error) {
    return { error: describe(error, "The teacher could not be assigned."), attempt: next(prev) };
  }
}

/** The Remove teacher control goes with the teacher, so the section page confirms it. */
export async function removeSectionTeacherAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  const ids = sectionIds(formData);
  let teacherName: string;
  try {
    ({ teacherName } = await removeCourseSectionTeacher(actor, ids));
  } catch (error) {
    return { error: describe(error, "The teacher could not be removed."), attempt: next(prev) };
  }
  redirect(`${sectionPath(ids)}?teacherRemoved=${encodeURIComponent(teacherName)}`);
}

export async function inviteSectionTeacherAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  const values = {
    name: text(formData, "name"),
    email: text(formData, "email"),
    employeeCode: text(formData, "employeeCode"),
  };
  try {
    const { invited, assignError } = await inviteTeacherForCourseSection(actor, {
      ...sectionIds(formData),
      ...values,
      // The teacher the form showed: a section that has changed hands since is not given away blindly.
      expectedTeacherId: formData.has("expectedTeacherId") ? text(formData, "expectedTeacherId") : undefined,
    });
    refresh();
    return {
      message: assignError
        ? `${invited.member.name}'s account was created, but the section could not be assigned: ${assignError}`
        : `${invited.member.name} now teaches this section and can sign in with ${invited.member.email}.`,
      password: invited.password,
      passwordLabel: `Temporary password for ${invited.member.email}`,
      passwordNote: TEACHER_PASSWORD_NOTE,
      attempt: next(prev),
    };
  } catch (error) {
    return { error: describe(error, "The teacher's account could not be created."), values, attempt: next(prev) };
  }
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

function readStudentForm(formData: FormData): StudentFormValues {
  return {
    studentCode: text(formData, "studentCode"),
    firstName: text(formData, "firstName"),
    lastName: text(formData, "lastName"),
    email: text(formData, "email"),
    phone: text(formData, "phone"),
    campusId: text(formData, "campusId"),
    admissionNumber: text(formData, "admissionNumber"),
    admissionDate: text(formData, "admissionDate"),
    status: "",
    cohortId: "",
  };
}

/**
 * Adds one student chosen from the add-student search. The page it came from
 * shows the result — the search kept, the student now marked as in the
 * section — so several can be added one after another.
 */
export async function addStudentToSectionAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  const ids = sectionIds(formData);
  let studentId: string;
  try {
    ({ studentId } = await addStudentToSection(actor, ids, text(formData, "studentId"), {
      moveFrom: text(formData, "moveFrom") || undefined,
    }));
  } catch (error) {
    return {
      error: describe(error, "The student could not be added."),
      conflict: error instanceof SameCourseConflict ? error.current : undefined,
      attempt: next(prev),
    };
  }
  const query = new URLSearchParams({ added: studentId });
  const search = text(formData, "q").trim();
  if (search) query.set("q", search);
  redirect(`${sectionPath(ids)}/students/add?${query}`);
}

export async function addStudentsToSectionAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  try {
    const { added, skipped } = await addStudentsToSection(actor, sectionIds(formData), text(formData, "studentCodes"));
    if (added.length > 0) refresh();
    return {
      ...(added.length > 0
        ? { message: `${added.length === 1 ? "Added" : `Added ${added.length} students:`} ${added.join(", ")}.` }
        : { error: "Nobody was added." }),
      details: skipped,
      values: added.length > 0 ? undefined : { studentCodes: text(formData, "studentCodes") },
      attempt: next(prev),
    };
  } catch (error) {
    return {
      error: describe(error, "The students could not be added."),
      values: { studentCodes: text(formData, "studentCodes") },
      attempt: next(prev),
    };
  }
}

/**
 * Takes a student out of a section. The row that asked goes with them, so the
 * confirmation is the section page's own notice rather than the row's.
 */
export async function removeStudentFromSectionAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  const ids = sectionIds(formData);
  let name: string;
  try {
    ({ name } = await removeStudentFromSection(actor, ids, text(formData, "studentId")));
  } catch (error) {
    return { error: describe(error, "The student could not be removed."), attempt: next(prev) };
  }
  redirect(`${sectionPath(ids)}?removedStudent=${encodeURIComponent(name)}`);
}

// ---------------------------------------------------------------------------
// A department's faculty
// ---------------------------------------------------------------------------

const DEPARTMENT_BASE = "/dashboard/college/departments";

/** The password note for a teacher: they cannot change their own, so say who can issue another. */
const TEACHER_PASSWORD_NOTE =
  "Copy this now — it is shown once and cannot be recovered. Hand it over in person or by a channel you trust. " +
  "If it is lost, the college administrator can issue a new one.";

/**
 * Adds a teacher to the department — a new sign-in account in this department
 * with the teaching role, through the Faculty page's own service. The password
 * comes back here once and is shown once; nothing else keeps it.
 */
export async function addFacultyAction(prev: CollegeActionState, formData: FormData): Promise<CollegeActionState> {
  const actor = await requireUser();
  const values = {
    name: text(formData, "name"),
    email: text(formData, "email"),
    employeeCode: text(formData, "employeeCode"),
  };
  try {
    const invited = await addDepartmentFaculty(actor, { departmentId: text(formData, "departmentId"), ...values });
    refresh();
    return {
      message: `${invited.member.name} was added to the department and signs in with ${invited.member.email}.`,
      password: invited.password,
      passwordLabel: `Temporary password for ${invited.member.email}`,
      passwordNote: TEACHER_PASSWORD_NOTE,
      createdId: invited.member.id,
      attempt: next(prev),
    };
  } catch (error) {
    return { error: describe(error, "The teacher's account could not be created."), values, attempt: next(prev) };
  }
}

export async function updateFacultyAction(prev: CollegeActionState, formData: FormData): Promise<CollegeActionState> {
  const actor = await requireUser();
  const values = { name: text(formData, "name"), employeeCode: text(formData, "employeeCode") };
  try {
    const { name } = await updateDepartmentFacultyMember(actor, {
      departmentId: text(formData, "departmentId"),
      userId: text(formData, "userId"),
      ...values,
    });
    refresh();
    return { message: `Saved ${name}'s details.`, attempt: next(prev) };
  } catch (error) {
    return { error: describe(error, "The details could not be saved."), values, attempt: next(prev) };
  }
}

/** Disable and Enable are one control that swaps in place, so each answer is the control's own. */
export async function setFacultyActiveAction(prev: CollegeActionState, formData: FormData): Promise<CollegeActionState> {
  const actor = await requireUser();
  const active = text(formData, "active") === "1";
  try {
    const { name } = await setDepartmentFacultyActive(actor, {
      departmentId: text(formData, "departmentId"),
      userId: text(formData, "userId"),
      active,
    });
    refresh();
    return {
      message: active
        ? `${name} can sign in again.`
        : `${name} can no longer sign in, and has been signed out everywhere. Their sections keep them as their teacher until they are given to somebody else.`,
      attempt: next(prev),
    };
  } catch (error) {
    return { error: describe(error, "The account could not be changed."), attempt: next(prev) };
  }
}

export async function assignFacultyToSectionAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  try {
    const { teacherName, replaced } = await assignFacultyToSection(actor, {
      departmentId: text(formData, "departmentId"),
      userId: text(formData, "userId"),
      sectionId: text(formData, "sectionId"),
      expectedTeacherId: text(formData, "expectedTeacherId"),
    });
    refresh();
    return {
      message: `${teacherName} now teaches ${text(formData, "sectionName") || "the section"}.${replaced.length ? ` ${replaced.join(", ")} no longer does.` : ""}`,
      attempt: next(prev),
    };
  } catch (error) {
    return { error: describe(error, "The section could not be assigned."), attempt: next(prev) };
  }
}

// ---------------------------------------------------------------------------
// A department's students
// ---------------------------------------------------------------------------

function studentPath(departmentId: string, studentId: string): string {
  return `${DEPARTMENT_BASE}/${encodeURIComponent(departmentId)}/students/${encodeURIComponent(studentId)}`;
}

/**
 * Adds an existing student to one of the department's sections, or moves them
 * there from another section of that course when the form says so — then
 * opens the student, where the new section now appears.
 */
export async function addStudentToDepartmentSectionAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  const departmentId = text(formData, "departmentId");
  let result: { studentId: string; moved: boolean; ids: { sectionId: string } };
  try {
    result = await addStudentToDepartmentSection(actor, {
      departmentId,
      studentId: text(formData, "studentId"),
      sectionId: text(formData, "sectionId"),
      moveFrom: text(formData, "moveFrom") || undefined,
    });
  } catch (error) {
    return {
      error: describe(error, "The student could not be added."),
      conflict: error instanceof SameCourseConflict ? error.current : undefined,
      values: { sectionId: text(formData, "sectionId") },
      attempt: next(prev),
    };
  }
  const query = new URLSearchParams({ [result.moved ? "moved" : "added"]: result.ids.sectionId });
  redirect(`${studentPath(departmentId, result.studentId)}?${query}`);
}

/**
 * Takes a student out of one of the department's sections — nothing else
 * about them changes — and returns to them, or to the student list when that
 * was their last section of the department.
 */
export async function removeStudentFromDepartmentSectionAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  const departmentId = text(formData, "departmentId");
  const studentId = text(formData, "studentId");
  let removed: { name: string; stillInDepartment: boolean };
  try {
    removed = await removeStudentFromDepartmentSection(actor, {
      departmentId,
      studentId,
      sectionId: text(formData, "sectionId"),
    });
  } catch (error) {
    return { error: describe(error, "The student could not be removed."), attempt: next(prev) };
  }
  const sectionName = text(formData, "sectionName");
  if (removed.stillInDepartment) {
    redirect(`${studentPath(departmentId, studentId)}?${new URLSearchParams({ removed: sectionName })}`);
  }
  redirect(
    `${DEPARTMENT_BASE}/${encodeURIComponent(departmentId)}/students?${new URLSearchParams({ removedStudent: removed.name, from: sectionName })}`,
  );
}

/**
 * The new-student form's state. `created` is the only place a new student's
 * temporary password exists once the request is over: in the browser that
 * admitted them, until that page is left or Done is pressed.
 */
export interface NewStudentState {
  error?: string;
  /** What was typed, echoed back on a refusal so the form does not clear itself. */
  values?: Record<string, string>;
  attempt?: number;
  created?: {
    studentId: string;
    name: string;
    studentCode: string;
    email: string;
    password: string;
    /** The student's page, where Done leads. */
    href: string;
  };
}

/**
 * A new student and their Student Portal login, admitted from the
 * department's Add student page or from a section's own — into the section
 * chosen, which the service checks is the department's. The temporary
 * password comes back in this response and nowhere else: not in a URL or a
 * redirect, and not kept anywhere it could be read from again.
 */
export async function createDepartmentStudentAction(
  prev: NewStudentState,
  formData: FormData,
): Promise<NewStudentState> {
  const actor = await requireUser();
  const sectionId = text(formData, "sectionId");
  const values = readStudentForm(formData);
  const attempt = next(prev);
  try {
    const admitted = await createDepartmentStudent(
      actor,
      { departmentId: text(formData, "departmentId"), sectionId },
      values,
    );
    return {
      attempt,
      created: {
        studentId: admitted.studentId,
        name: admitted.name,
        studentCode: admitted.studentCode,
        email: admitted.email,
        password: admitted.password,
        href: `${studentPath(admitted.departmentId, admitted.studentId)}?created=1`,
      },
    };
  } catch (error) {
    return { error: describe(error, "The student could not be added."), values: { ...values, sectionId }, attempt };
  }
}

/** Under every temporary password issued for a student here. */
const STUDENT_PASSWORD_NOTE =
  "Hand it over in person or by a channel you trust. The student must choose a new password when they first sign in. Their current password can be revealed later with Show current password on this page, and every reveal is recorded.";

/**
 * A Student Portal login for one of the department's students who has none,
 * with the college email they will sign in with. The password is shown once.
 */
export async function createDepartmentStudentLoginAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  const email = text(formData, "email");
  try {
    const created = await createDepartmentStudentLogin(actor, {
      departmentId: text(formData, "departmentId"),
      studentId: text(formData, "studentId"),
      email,
    });
    refresh();
    return {
      message: `${created.name} can now sign in to the Student Portal with ${created.email}.`,
      password: created.password,
      passwordLabel: `Temporary password for ${created.name} (student ID ${created.loginId})`,
      passwordNote: STUDENT_PASSWORD_NOTE,
      attempt: next(prev),
    };
  } catch (error) {
    return { error: describe(error, "The login could not be created."), values: { email }, attempt: next(prev) };
  }
}

/**
 * A new temporary password for one of the department's students. The old one
 * stops working at once and every device is signed out; the new one is shown
 * once, and the student must replace it when they next sign in.
 */
export async function resetDepartmentStudentPasswordAction(
  prev: CollegeActionState,
  formData: FormData,
): Promise<CollegeActionState> {
  const actor = await requireUser();
  try {
    const issued = await resetDepartmentStudentPassword(actor, {
      departmentId: text(formData, "departmentId"),
      studentId: text(formData, "studentId"),
    });
    refresh();
    return {
      message: `${issued.name}'s old password has stopped working, and they have been signed out everywhere.`,
      password: issued.password,
      passwordLabel: `New temporary password for ${issued.name} (student ID ${issued.loginId})`,
      passwordNote: STUDENT_PASSWORD_NOTE,
      attempt: next(prev),
    };
  } catch (error) {
    return { error: describe(error, "A new password could not be issued."), attempt: next(prev) };
  }
}

// ---------------------------------------------------------------------------
// Face enrolment for a department's student
// ---------------------------------------------------------------------------

/**
 * The same input the administrator's enrolment actions accept — the image
 * bounded and checked to be a JPEG, PNG or WebP before it goes anywhere — plus
 * the department it is enrolled from, which the service checks.
 */
const departmentEnrollmentSchema = z.object({
  departmentId: z.string().min(1),
  studentId: z.string().min(1),
  imageBase64: imageBase64Field(),
  captureSource: z.enum(["CAMERA", "UPLOAD"]),
});

export async function enrollDepartmentStudentFaceAction(
  input: z.infer<typeof departmentEnrollmentSchema>,
): Promise<FaceEnrollmentResult> {
  const actor = await requireUser();
  return enrollDepartmentStudentFace(actor, departmentEnrollmentSchema.parse(input), "add");
}

export async function replaceDepartmentStudentFaceAction(
  input: z.infer<typeof departmentEnrollmentSchema>,
): Promise<FaceEnrollmentResult> {
  const actor = await requireUser();
  return enrollDepartmentStudentFace(actor, departmentEnrollmentSchema.parse(input), "replace");
}

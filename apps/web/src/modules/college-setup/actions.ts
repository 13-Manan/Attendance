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

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import { FacultyError } from "@/modules/faculty/directory-types";
import type { StudentActionState, StudentFormValues } from "@/modules/students/directory-actions";
import { StudentError } from "@/modules/students/directory-types";
import { sectionLabel } from "./policy";
import {
  addCourseSections,
  addNewStudentToSection,
  addStudentToSection,
  addStudentsToSection,
  assignDepartmentHead,
  createCourse,
  createDepartment,
  createDepartmentHead,
  createSemester,
  inviteTeacherForCourseSection,
  removeCourse,
  removeCourseSection,
  removeCourseSectionTeacher,
  removeDepartmentHead,
  removeSemester,
  removeStudentFromSection,
  renameCourseSection,
  resetDepartmentHeadPassword,
  setCourseSectionTeacher,
  setCurrentSemester,
  setDepartmentHeadActive,
  updateCourse,
  updateDepartment,
  updateSemester,
} from "./service";
import { CollegeSetupError } from "./types";

export interface CollegeActionState {
  error?: string;
  message?: string;
  /** Further lines under the message: which students were added, which were not and why. */
  details?: string[];
  /** Shown once, immediately after it is issued. Never re-readable. */
  password?: string;
  passwordLabel?: string;
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
    });
    refresh();
    return {
      message: assignError
        ? `${invited.member.name}'s account was created, but the section could not be assigned: ${assignError}`
        : `${invited.member.name} now teaches this section and can sign in with ${invited.member.email}.`,
      password: invited.password,
      passwordLabel: `Temporary password for ${invited.member.email}`,
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
 * The existing Add student form, submitted from a section: the same fields,
 * checked by the same student service, and placed in this section only.
 */
export async function addNewStudentToSectionAction(
  prev: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  const actor = await requireUser();
  const ids = sectionIds(formData);
  const values = readStudentForm(formData);
  const attempt = (prev.attempt ?? 0) + 1;
  let studentId: string;
  try {
    ({ id: studentId } = await addNewStudentToSection(actor, ids, values));
  } catch (error) {
    return { error: describe(error, "The student could not be added."), values, attempt };
  }
  // The section names the student from its own list, so the notice can only
  // ever be about somebody who really is in it.
  redirect(`${sectionPath(ids)}?added=${encodeURIComponent(studentId)}`);
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
    ({ studentId } = await addStudentToSection(actor, ids, text(formData, "studentId")));
  } catch (error) {
    return { error: describe(error, "The student could not be added."), attempt: next(prev) };
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

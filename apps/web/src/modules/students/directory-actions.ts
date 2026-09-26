"use server";

/**
 * Server Actions for student administration.
 *
 * A boundary only: resolve the session user, read the form, call the service,
 * shape the result for the page. Authorization, tenancy, validation, audit and
 * the webhook all happen below this file, and no action here takes an
 * institution id — there is no form field a caller could add to reach another
 * tenant's students.
 */

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import { withReturnPath } from "@/lib/return-path";
import {
  assignStudentToClassForRequest,
  createStudentForRequest,
  removeStudentFromClassForRequest,
  setStudentStatusForRequest,
  updateStudentForRequest,
} from "./directory-service";
import { STUDENT_STATUS_LABEL, StudentError, type StudentStatus } from "./directory-types";
import {
  getStudentLogin,
  provisionStudentLogin,
  resetStudentLoginPassword,
  setStudentLoginEnabled,
} from "./login-provisioning";
import { studentDisplayName } from "./types";
import { parseSectionReturnPath } from "./class-navigation-paths";
import { studentOriginPath } from "./record-origin";

/** Every field of the student form, as strings, for redisplay after a refusal. */
export interface StudentFormValues {
  studentCode: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  campusId: string;
  admissionNumber: string;
  admissionDate: string;
  status: string;
  cohortId: string;
}

export interface StudentActionState {
  error?: string;
  message?: string;
  /** Echoed back so a refused submission does not clear the form. */
  values?: StudentFormValues;
  /** Changes on every submission, so the fields remount with the values above. */
  attempt?: number;
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof StudentError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have access to manage students.";
  return fallback;
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "");
}

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
    status: text(formData, "status"),
    cohortId: text(formData, "cohortId"),
  };
}

export async function createStudentAction(
  prev: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  const actor = await requireUser();
  const values = readStudentForm(formData);
  const attempt = (prev.attempt ?? 0) + 1;

  let studentId: string;
  try {
    const student = await createStudentForRequest(actor, values);
    studentId = student.id;
  } catch (error) {
    return { error: describe(error, "The student could not be added."), values, attempt };
  }

  // Outside the try/catch: redirect() signals by throwing, and catching it
  // here would report a successful admission as a failure.
  //
  // To the new record rather than back to the list: the next thing a clerk
  // does is place them in a class or enroll their face, and both are there.
  // Added from a section, they were placed already, so back to that section,
  // where the new student is listed with both links. `returnTo` is a form
  // field, so only an exact section-page path is followed.
  const section = parseSectionReturnPath(formData.get("returnTo"));
  if (section) redirect(`${section}?added=${encodeURIComponent(studentId)}`);
  redirect(`/dashboard/students/${studentId}?created=1`);
}

export async function updateStudentAction(
  prev: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  const actor = await requireUser();
  const values = readStudentForm(formData);
  const attempt = (prev.attempt ?? 0) + 1;
  const id = text(formData, "id");

  try {
    await updateStudentForRequest(actor, id, values);
  } catch (error) {
    return { error: describe(error, "The changes could not be saved."), values, attempt };
  }

  // Back to the record — still leading back to the section it was opened from,
  // if it was. `returnTo` is a form field, so it is checked again here.
  const origin = studentOriginPath(formData.get("returnTo"));
  redirect(withReturnPath(`/dashboard/students/${id}?saved=1`, origin));
}

/**
 * Archive a student, or bring one back.
 *
 * `refresh()` rather than a redirect: the administrator is looking at the
 * record they just changed and should keep looking at it, with the status
 * re-read from the database rather than guessed at by the client.
 */
export async function setStudentStatusAction(
  _prev: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  const actor = await requireUser();
  const id = text(formData, "id");
  const status = text(formData, "status");

  try {
    const student = await setStudentStatusForRequest(actor, id, status);
    refresh();
    const label = STUDENT_STATUS_LABEL[student.status as StudentStatus].toLowerCase();
    return {
      message:
        student.status === "ACTIVE"
          ? `${studentDisplayName(student)} is back on roll.`
          : `${studentDisplayName(student)} is ${label}. Their attendance history is kept.`,
    };
  } catch (error) {
    return { error: describe(error, "That change could not be made.") };
  }
}

export async function assignStudentClassAction(
  _prev: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  const actor = await requireUser();
  const studentId = text(formData, "studentId");
  const cohortId = text(formData, "cohortId");

  try {
    const { cohortName } = await assignStudentToClassForRequest(actor, { studentId, cohortId });
    refresh();
    return { message: `Placed in ${cohortName}.` };
  } catch (error) {
    return { error: describe(error, "That placement could not be made.") };
  }
}

export async function removeStudentClassAction(
  _prev: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  const actor = await requireUser();
  const studentId = text(formData, "studentId");
  const cohortId = text(formData, "cohortId");

  try {
    const { cohortName } = await removeStudentFromClassForRequest(actor, { studentId, cohortId });
    refresh();
    return {
      message: `Taken out of ${cohortName}. Registers already taken there still name them.`,
    };
  } catch (error) {
    return { error: describe(error, "That change could not be made.") };
  }
}

// ---------------------------------------------------------------------------
// Student portal logins
// ---------------------------------------------------------------------------

/**
 * The temporary password is carried back in the return value and nowhere else:
 * not in the URL, not in a redirect, not in the audit row. It survives exactly
 * one render.
 */
export interface StudentLoginFormState {
  error: string | null;
  /** `loginId` is the student ID the password goes with; `email` a real address, if the account has one. */
  issued: { loginId: string; email: string | null; password: string; notice: string } | null;
}

export async function provisionStudentLoginAction(
  _previous: StudentLoginFormState,
  formData: FormData,
): Promise<StudentLoginFormState> {
  const user = await requireUser();
  const studentId = String(formData.get("studentId") ?? "");
  const email = String(formData.get("email") ?? "");

  try {
    const result = await provisionStudentLogin(user, studentId, { email });
    refresh();
    return {
      error: null,
      issued: {
        loginId: result.account.loginId,
        email: result.account.email,
        password: result.password,
        notice: result.notice,
      },
    };
  } catch (error) {
    if (error instanceof StudentError) return { error: error.message, issued: null };
    if (error instanceof ForbiddenError) {
      return { error: "You do not have permission to provision a student login.", issued: null };
    }
    throw error;
  }
}

export async function resetStudentLoginAction(
  _previous: StudentLoginFormState,
  formData: FormData,
): Promise<StudentLoginFormState> {
  const user = await requireUser();
  const studentId = String(formData.get("studentId") ?? "");

  try {
    const result = await resetStudentLoginPassword(user, studentId);
    // Which ID the password goes with, read back rather than taken from the
    // form: the notice is the one place the two are shown together.
    const account = await getStudentLogin(user, studentId);
    refresh();
    return {
      error: null,
      issued: {
        loginId: account?.loginId ?? "",
        email: account?.email ?? null,
        password: result.password,
        notice: result.notice,
      },
    };
  } catch (error) {
    if (error instanceof StudentError) return { error: error.message, issued: null };
    if (error instanceof ForbiddenError) {
      return { error: "You do not have permission to do that.", issued: null };
    }
    throw error;
  }
}

export interface StudentLoginToggleState {
  error: string | null;
}

/** Switches a student's login off (ending its sessions) or back on. */
export async function setStudentLoginEnabledAction(
  _previous: StudentLoginToggleState,
  formData: FormData,
): Promise<StudentLoginToggleState> {
  const user = await requireUser();
  const studentId = String(formData.get("studentId") ?? "");
  const enabled = formData.get("enabled") === "1";

  try {
    await setStudentLoginEnabled(user, studentId, enabled);
    refresh();
    return { error: null };
  } catch (error) {
    if (error instanceof StudentError) return { error: error.message };
    if (error instanceof ForbiddenError) return { error: "You do not have permission to do that." };
    throw error;
  }
}

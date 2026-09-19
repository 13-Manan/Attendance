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
import {
  assignStudentToClassForRequest,
  createStudentForRequest,
  removeStudentFromClassForRequest,
  setStudentStatusForRequest,
  updateStudentForRequest,
} from "./directory-service";
import { STUDENT_STATUS_LABEL, StudentError, type StudentStatus } from "./directory-types";
import { studentDisplayName } from "./types";

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

  redirect(`/dashboard/students/${id}?saved=1`);
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

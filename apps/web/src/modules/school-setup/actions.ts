"use server";

/**
 * Server Actions for the school Classes screens.
 *
 * A boundary only: resolve the session user, read the form, call the service,
 * shape the result for the page. Authorization, tenancy, validation and audit
 * all happen in `service.ts`, and no action here takes an institution id.
 *
 * The temporary password returned by `inviteTeacherForSectionAction` goes to
 * the browser that submitted the form and nowhere else — the same lifetime as
 * on the Faculty page; see `modules/faculty/directory-actions.ts`.
 */

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import { FacultyError } from "@/modules/faculty/directory-types";
import {
  addSection,
  createClass,
  inviteTeacherForSection,
  removeSection,
  removeSectionTeacher,
  renameClass,
  renameSection,
  setSectionTeacher,
} from "./service";
import { sectionLabel } from "./policy";
import { SchoolSetupError } from "./types";

export interface SchoolSetupActionState {
  error?: string;
  message?: string;
  /** Shown once, immediately after it is issued. Never re-readable. */
  password?: string;
  passwordLabel?: string;
  /** Changes on every submission, so a form can reset itself after a success. */
  attempt?: number;
  /** What was typed, echoed back on a refusal so the form does not clear itself. */
  values?: Record<string, string>;
}

const BASE = "/dashboard/academic/classes";

function describe(error: unknown, fallback: string): string {
  if (error instanceof SchoolSetupError || error instanceof FacultyError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have access to change classes.";
  return fallback;
}

function text(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "");
}

function next(prev: SchoolSetupActionState): number {
  return (prev.attempt ?? 0) + 1;
}

export async function createClassAction(
  prev: SchoolSetupActionState,
  formData: FormData,
): Promise<SchoolSetupActionState> {
  const actor = await requireUser();
  const yearId = text(formData, "yearId");
  const names = formData.getAll("sectionName").map(String);
  const teachers = formData.getAll("teacherId").map(String);

  let created: { classId: string };
  try {
    created = await createClass(actor, {
      yearId,
      className: text(formData, "className"),
      sections: names.map((name, index) => ({ name, teacherId: teachers[index] ?? "" })),
    });
  } catch (error) {
    return { error: describe(error, "The class could not be created."), attempt: next(prev) };
  }
  // Outside the try/catch: redirect() signals by throwing.
  redirect(`${BASE}/${created.classId}?year=${encodeURIComponent(yearId)}&created=1`);
}

export async function renameClassAction(
  prev: SchoolSetupActionState,
  formData: FormData,
): Promise<SchoolSetupActionState> {
  const actor = await requireUser();
  try {
    const { name } = await renameClass(actor, {
      classId: text(formData, "classId"),
      yearId: text(formData, "yearId"),
      name: text(formData, "name"),
    });
    refresh();
    return { message: `Renamed to ${name}.`, attempt: next(prev) };
  } catch (error) {
    return {
      error: describe(error, "The class could not be renamed."),
      values: { name: text(formData, "name") },
      attempt: next(prev),
    };
  }
}

export async function addSectionAction(
  prev: SchoolSetupActionState,
  formData: FormData,
): Promise<SchoolSetupActionState> {
  const actor = await requireUser();
  try {
    const { name } = await addSection(actor, {
      classId: text(formData, "classId"),
      yearId: text(formData, "yearId"),
      name: text(formData, "name"),
      teacherId: text(formData, "teacherId"),
    });
    refresh();
    return { message: `${sectionLabel(name)} added.`, attempt: next(prev) };
  } catch (error) {
    return {
      error: describe(error, "The section could not be added."),
      values: { name: text(formData, "name"), teacherId: text(formData, "teacherId") },
      attempt: next(prev),
    };
  }
}

export async function renameSectionAction(
  prev: SchoolSetupActionState,
  formData: FormData,
): Promise<SchoolSetupActionState> {
  const actor = await requireUser();
  try {
    const { name } = await renameSection(actor, {
      sectionId: text(formData, "sectionId"),
      name: text(formData, "name"),
    });
    refresh();
    return { message: `Renamed to ${name}.`, attempt: next(prev) };
  } catch (error) {
    return {
      error: describe(error, "The section could not be renamed."),
      values: { name: text(formData, "name") },
      attempt: next(prev),
    };
  }
}

export async function setSectionTeacherAction(
  prev: SchoolSetupActionState,
  formData: FormData,
): Promise<SchoolSetupActionState> {
  const actor = await requireUser();
  try {
    const { teacherName, replaced } = await setSectionTeacher(actor, {
      sectionId: text(formData, "sectionId"),
      teacherId: text(formData, "teacherId"),
    });
    refresh();
    return {
      message:
        replaced.length > 0
          ? `${teacherName} now teaches this section, in place of ${replaced.join(", ")}.`
          : `${teacherName} now teaches this section.`,
      attempt: next(prev),
    };
  } catch (error) {
    return { error: describe(error, "The teacher could not be assigned."), attempt: next(prev) };
  }
}

export async function removeSectionTeacherAction(
  prev: SchoolSetupActionState,
  formData: FormData,
): Promise<SchoolSetupActionState> {
  const actor = await requireUser();
  try {
    const { teacherName } = await removeSectionTeacher(actor, text(formData, "sectionId"));
    refresh();
    return {
      message: `${teacherName} no longer teaches this section. Their account is unchanged.`,
      attempt: next(prev),
    };
  } catch (error) {
    return { error: describe(error, "The teacher could not be removed."), attempt: next(prev) };
  }
}

export async function inviteTeacherForSectionAction(
  prev: SchoolSetupActionState,
  formData: FormData,
): Promise<SchoolSetupActionState> {
  const actor = await requireUser();
  try {
    const { invited, assignError } = await inviteTeacherForSection(actor, {
      sectionId: text(formData, "sectionId"),
      name: text(formData, "name"),
      email: text(formData, "email"),
      employeeCode: text(formData, "employeeCode"),
    });
    refresh();
    const who = `${invited.member.name} can now sign in with ${invited.member.email}`;
    return {
      message: assignError
        ? `${who}, but the section was not assigned: ${assignError}`
        : `${who} and teaches this section.`,
      error: assignError ?? undefined,
      password: invited.password,
      passwordLabel: `Temporary password for ${invited.member.email}`,
      attempt: next(prev),
    };
  } catch (error) {
    return {
      error: describe(error, "The teacher's account could not be created."),
      values: {
        name: text(formData, "name"),
        email: text(formData, "email"),
        employeeCode: text(formData, "employeeCode"),
      },
      attempt: next(prev),
    };
  }
}

export async function removeSectionAction(
  prev: SchoolSetupActionState,
  formData: FormData,
): Promise<SchoolSetupActionState> {
  const actor = await requireUser();
  const yearId = text(formData, "yearId");
  let removed: { classId: string; classRemoved: boolean; name: string };
  try {
    removed = await removeSection(actor, text(formData, "sectionId"));
  } catch (error) {
    return { error: describe(error, "The section could not be removed."), attempt: next(prev) };
  }
  const query = `year=${encodeURIComponent(yearId)}&removed=${encodeURIComponent(removed.name)}`;
  redirect(removed.classRemoved ? `${BASE}?${query}` : `${BASE}/${removed.classId}?${query}`);
}

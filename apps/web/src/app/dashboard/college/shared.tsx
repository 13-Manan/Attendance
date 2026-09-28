import Link from "next/link";
import { redirect } from "next/navigation";
import type { BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { ForbiddenError } from "@/modules/authorization/types";
import { CollegeSetupError, type CourseStatus, type SectionStatus, type SessionChoice } from "@/modules/college-setup/types";

export { LINK_PRIMARY, LINK_SECONDARY } from "../academic/classes/shared";

/** Pieces shared by the college pages. Server components only — nothing here holds state. */

export const BASE = "/dashboard/college/departments";

/** When somebody last did something — a sign-in — as the student record shows it. */
export const MOMENT_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export const SECTION_TONE: Record<SectionStatus, BadgeTone> = {
  ready: "positive",
  needs_teacher: "warning",
  teacher_inactive: "danger",
};

export const COURSE_TONE: Record<CourseStatus, BadgeTone> = {
  ready: "positive",
  needs_teacher: "warning",
  no_sections: "neutral",
};

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function departmentHref(departmentId: string): string {
  return `${BASE}/${encodeURIComponent(departmentId)}`;
}

export function semesterHref(departmentId: string, semesterId: string): string {
  return `${departmentHref(departmentId)}/semesters/${encodeURIComponent(semesterId)}`;
}

export function courseHref(departmentId: string, semesterId: string, courseId: string): string {
  return `${semesterHref(departmentId, semesterId)}/courses/${encodeURIComponent(courseId)}`;
}

export function sectionHref(departmentId: string, semesterId: string, courseId: string, sectionId: string): string {
  return `${courseHref(departmentId, semesterId, courseId)}/sections/${encodeURIComponent(sectionId)}`;
}

/** A section's pages below it: the add-student search, the new-student form, one student. */
export function sectionStudentsHref(
  ids: { departmentId: string; semesterId: string; courseId: string; sectionId: string },
  page: "add" | "new" | { studentId: string },
): string {
  const base = `${sectionHref(ids.departmentId, ids.semesterId, ids.courseId, ids.sectionId)}/students`;
  return typeof page === "string" ? `${base}/${page}` : `${base}/${encodeURIComponent(page.studentId)}`;
}

/** A department's Faculty or Students page, or a page below one: a person, "Add student", face enrolment. */
export function departmentPeopleHref(
  departmentId: string,
  list: "faculty" | "students",
  ...below: string[]
): string {
  return [`${departmentHref(departmentId)}/${list}`, ...below.map(encodeURIComponent)].join("/");
}

/** "Physics (PHY401)": a course named for a form that is about it. */
export function courseWithCode(course: { name: string; code: string | null }): string {
  return course.code ? `${course.name} (${course.code})` : course.name;
}

/** `?session=` for links that should keep the session being viewed. */
export function withSession(href: string, session: SessionChoice | null, all: readonly SessionChoice[]): string {
  if (!session || session.isCurrent || all.length < 2) return href;
  return `${href}${href.includes("?") ? "&" : "?"}session=${encodeURIComponent(session.id)}`;
}

export { COURSES_PATH, courseTitle, courseTrail, departmentTrail } from "./trail";

/**
 * Runs a page's read, turning a refusal into the same /unauthorized page
 * every other screen uses, and a college-setup message into text the page
 * shows. Anything else is a bug and is thrown on.
 */
export async function readOrDeny<T>(
  read: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    if (error instanceof ForbiddenError) redirect("/unauthorized");
    if (error instanceof CollegeSetupError) return { ok: false, message: error.message };
    throw error;
  }
}

/**
 * Which academic session a college page shows. A plain GET form, so it works
 * before the page's JavaScript has loaded and the choice is in the URL.
 */
export function SessionSwitcher({
  action,
  sessions,
  selectedId,
  hidden = {},
}: {
  action: string;
  sessions: readonly SessionChoice[];
  selectedId: string;
  hidden?: Record<string, string>;
}) {
  if (sessions.length < 2) return null;
  return (
    <form method="get" action={action} className="flex items-end gap-2">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="session-switcher" className="text-xs font-medium text-neutral-500">
          Academic session
        </label>
        <Select id="session-switcher" name="session" defaultValue={selectedId} className="min-w-40">
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {session.name}
              {session.isCurrent ? " (current)" : session.isActive ? "" : " (archived)"}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" variant="secondary">
        Show
      </Button>
    </form>
  );
}

export function Notice({ tone = "success", children }: { tone?: "success" | "info"; children: React.ReactNode }) {
  return (
    <p
      role="status"
      className={
        tone === "success"
          ? "rounded-md bg-green-50 px-3 py-2 text-sm text-green-800"
          : "rounded-md bg-neutral-100 px-3 py-2 text-sm text-neutral-700"
      }
    >
      {children}
    </p>
  );
}

/** A labelled number, as on the department and overview pages. */
export function Figure({ label, value, href }: { label: string; value: number; href?: string }) {
  const body = (
    <>
      <span className="text-xs font-medium tracking-wide text-neutral-500 uppercase">{label}</span>
      <span className="text-2xl font-semibold tabular-nums text-neutral-900">{value.toLocaleString()}</span>
    </>
  );
  return href ? (
    <Link
      href={href}
      className="flex min-h-11 flex-col gap-1 rounded-md border border-neutral-200 bg-white p-3 hover:border-neutral-400 focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:outline-none"
    >
      {body}
    </Link>
  ) : (
    <div className="flex flex-col gap-1 rounded-md border border-neutral-200 bg-white p-3">{body}</div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import {
  getStudentForRequest,
  getStudentFormOptionsForRequest,
} from "@/modules/students/directory-service";
import {
  STUDENT_STATUS_DESCRIPTION,
  STUDENT_STATUS_LABEL,
  StudentError,
  type StudentClassLink,
  type StudentStatus,
} from "@/modules/students/directory-types";
import { studentDisplayName } from "@/modules/students/types";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
  AssignStudentClassControl,
  RemoveStudentClassControl,
  StudentStatusControl,
} from "../student-controls";

interface PageProps {
  params: Promise<{ studentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const BASE = "/dashboard/students";

/** UTC, because an admission date is a calendar day, not an instant. */
const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** Local, because a record's history is about when somebody did something. */
const MOMENT_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const STATUS_TONE: Record<StudentStatus, BadgeTone> = {
  ACTIVE: "positive",
  INACTIVE: "neutral",
  TRANSFERRED: "neutral",
  COMPLETED: "info",
};

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="text-sm text-neutral-900">{children}</dd>
    </div>
  );
}

function Missing({ children }: { children: ReactNode }) {
  return <span className="text-sm text-neutral-400">{children}</span>;
}

function classTitle(link: StudentClassLink): string {
  return link.termLabel ? `${link.cohortName} · ${link.termLabel}` : link.cohortName;
}

/**
 * One student's record.
 *
 * The page a clerk lands on after admitting somebody and the page they come
 * back to when a parent rings up, so it holds the three things that get asked
 * for: who the student is, which classes they are in now and which they were in
 * before, and whether their face is enrolled.
 *
 * Every control is gated on the permission for the thing it does rather than on
 * one blanket "can edit": a role that may place students in classes but not
 * rename them sees the placement controls and no edit link, and the server
 * checks the same permission again when the action runs.
 *
 * Past placements are shown, not hidden. A student who moved from 9A to 9B in
 * March has attendance in both, and a record that only shows 9B makes the
 * earlier registers look like they belong to nobody.
 */
export default async function StudentPage({ params, searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("student.read");
  const { studentId } = await params;
  const query = await searchParams;

  const canUpdate = hasPermission(user, "student.update");
  const canPlace = hasPermission(user, "enrollment.manage");
  const canManageFace = hasPermission(user, "faceEmbedding.manage");

  let student;
  try {
    student = await getStudentForRequest(user, studentId);
  } catch (error) {
    // "Does not exist" and "belongs to another institution" arrive here as the
    // same error on purpose, and both leave as the same 404 page.
    if (error instanceof StudentError) notFound();
    throw error;
  }

  // Only fetched when there is a control that needs it.
  const options = canPlace ? await getStudentFormOptionsForRequest(user) : null;

  const currentIds = new Set(student.classes.map((link) => link.enrollmentId));
  const pastClasses = student.allClasses.filter((link) => !currentIds.has(link.enrollmentId));

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <div>
        <Link href={BASE} className="text-xs text-neutral-500 hover:text-neutral-900">
          ← All students
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-neutral-900">
              {studentDisplayName(student)}
            </h1>
            <Badge tone={STATUS_TONE[student.status]}>
              {STUDENT_STATUS_LABEL[student.status]}
            </Badge>
          </div>
          <p className="font-mono text-xs text-neutral-500">{student.studentCode}</p>
        </div>
        {canUpdate ? (
          <Link
            href={`${BASE}/${student.id}/edit`}
            className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50"
          >
            Edit details
          </Link>
        ) : null}
      </header>

      {query.created === "1" ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          Student added. Place them in a class below, or enrol their face when they are in front of
          you.
        </p>
      ) : null}
      {query.saved === "1" ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          Changes saved.
        </p>
      ) : null}

      <Panel title="Details">
        <dl className="grid gap-4 sm:grid-cols-2">
          <Detail label="Student code">
            <span className="font-mono">{student.studentCode}</span>
          </Detail>
          <Detail label="Status">
            {STUDENT_STATUS_LABEL[student.status]}
            <span className="block text-xs text-neutral-500">
              {STUDENT_STATUS_DESCRIPTION[student.status]}
            </span>
          </Detail>
          <Detail label="Admission number">
            {student.admissionNumber ?? <Missing>Not on file</Missing>}
          </Detail>
          <Detail label="Admission date">
            {student.admissionDate ? (
              DAY_FORMAT.format(student.admissionDate)
            ) : (
              <Missing>Not on file</Missing>
            )}
          </Detail>
          <Detail label="Email">{student.email ?? <Missing>Not on file</Missing>}</Detail>
          <Detail label="Phone">{student.phone ?? <Missing>Not on file</Missing>}</Detail>
          <Detail label="Campus">{student.campusName ?? <Missing>No campus</Missing>}</Detail>
          <Detail label="Record">
            Added {MOMENT_FORMAT.format(student.createdAt)}
            <span className="block text-xs text-neutral-500">
              Last changed {MOMENT_FORMAT.format(student.updatedAt)}
            </span>
          </Detail>
        </dl>
      </Panel>

      <Panel
        title="Classes"
        description="Where this student is on the register. Taking them out of a class does not touch the registers already taken there."
      >
        {student.classes.length === 0 ? (
          <EmptyState>
            Not in any class, so they will not appear on any register. Place them in one below.
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {student.classes.map((link) => (
              <li
                key={link.enrollmentId}
                className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0"
              >
                <div className="flex flex-col gap-0.5">
                  <p className="text-sm font-medium text-neutral-900">{classTitle(link)}</p>
                  <p className="text-xs text-neutral-500">
                    {link.academicSessionName}
                    {link.academicSessionIsCurrent ? " (current year)" : ""} · since{" "}
                    {DAY_FORMAT.format(link.enrolledAt)}
                  </p>
                </div>
                {canPlace ? <RemoveStudentClassControl student={student} link={link} /> : null}
              </li>
            ))}
          </ul>
        )}

        {canPlace && options ? (
          <div className="border-t border-neutral-200 pt-4">
            <AssignStudentClassControl student={student} cohorts={options.cohorts} />
          </div>
        ) : null}
      </Panel>

      {pastClasses.length > 0 ? (
        <Panel
          title="Past classes"
          description="Classes this student has left. Their attendance in each is kept."
        >
          <ul className="flex flex-col divide-y divide-neutral-100">
            {pastClasses.map((link) => (
              <li key={link.enrollmentId} className="flex flex-col gap-0.5 py-3 first:pt-0">
                <p className="text-sm text-neutral-700">{classTitle(link)}</p>
                <p className="text-xs text-neutral-500">
                  {link.academicSessionName} · {DAY_FORMAT.format(link.enrolledAt)} to{" "}
                  {link.unenrolledAt ? DAY_FORMAT.format(link.unenrolledAt) : "—"}
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel
        title="Face enrolment"
        description="Face recognition is an assistant. A teacher always confirms the register."
        action={
          canManageFace ? (
            <Link
              href={`${BASE}/${student.id}/enroll-face`}
              className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50"
            >
              {student.faceSampleCount === 0 ? "Enrol face" : "Manage face data"}
            </Link>
          ) : null
        }
      >
        {/* Counts only. Nothing on this page reads a face vector. */}
        {student.faceSampleCount === 0 ? (
          <EmptyState>
            No face samples on file. This student is marked by hand, which is always allowed.
          </EmptyState>
        ) : (
          <p className="text-sm text-neutral-600">
            {student.activeFaceSampleCount} active{" "}
            {student.activeFaceSampleCount === 1 ? "sample" : "samples"} of{" "}
            {student.faceSampleCount} on file.
            {student.activeFaceSampleCount === 0
              ? " None are in use, so recognition will not suggest this student."
              : ""}
          </p>
        )}
      </Panel>

      {canUpdate ? (
        <Panel
          title="Roll"
          description="A student is never deleted. Taking them off roll keeps their history and stops them appearing on new registers."
        >
          <StudentStatusControl student={student} />
        </Panel>
      ) : null}
    </div>
  );
}

import Link from "next/link";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { getFacultyDashboard } from "@/modules/attendance-analytics/service";
import { institutionToday } from "@/modules/attendance-today/policy";
import { hasAnyPermission, hasPermission } from "@/modules/authorization/service";
import { getInstitutionById } from "@/modules/institutions/repository";
import { EMPTY_STUDENT_FILTERS } from "@/modules/students/directory-filters";
import { listStudentsForRequest } from "@/modules/students/directory-service";
import { CameraIcon } from "@/components/attendance/icons";
import { SessionRow } from "@/components/attendance/session-list";
import { EmptyState, Panel } from "@/components/ui/panel";

/**
 * A school receptionist's home: today's operational work, and only the parts
 * the principal switched on.
 *
 * Every card is decided by the same permission the page it leads to checks,
 * so nothing here is a button that would fail; and every figure comes from the
 * existing services — the register list, the student directory and its
 * verification counts — never a second definition of the same thing.
 */

const PRIMARY = "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-neutral-900 px-5 text-base font-semibold text-white transition-colors hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2";
const SECONDARY = "inline-flex min-h-11 items-center justify-center rounded-lg border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900";
const LINK = "inline-flex min-h-11 items-center text-sm font-medium text-neutral-700 underline-offset-4 hover:text-neutral-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 rounded-sm";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export async function ReceptionistHome({ user }: { user: SessionUser }) {
  const can = (permission: Parameters<typeof hasPermission>[1]) => hasPermission(user, permission);
  const readsAttendance = can("attendanceRecord.read");
  const takesAttendance = can("attendanceSession.create") && can("attendanceSession.capture");
  const readsStudents = can("student.read");
  const enrolsFaces = hasAnyPermission(user, "faceEmbedding.manage", "faceEmbedding.enroll");

  // Independent reads, and each one a convenience: a card that cannot be
  // built is left out rather than taking the page with it.
  const [institution, dashboard, students, facePending] = await Promise.all([
    user.institutionId ? getInstitutionById(user.institutionId) : Promise.resolve(null),
    readsAttendance ? getFacultyDashboard(user).catch(() => null) : Promise.resolve(null),
    readsStudents ? listStudentsForRequest(user, EMPTY_STUDENT_FILTERS).catch(() => null) : Promise.resolve(null),
    readsStudents && enrolsFaces
      ? listStudentsForRequest(user, { ...EMPTY_STUDENT_FILTERS, verification: "face_pending" }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const today = institutionToday(new Date(), institution?.timezone);

  const attendanceCard =
    readsAttendance || takesAttendance ? (
      <Panel
        title="Attendance today"
        description={
          dashboard
            ? `${plural(dashboard.today.length, "register")} taken today · ${plural(dashboard.pendingReview.length, "register")} waiting for review`
            : "Every class's register."
        }
      >
        {takesAttendance ? (
          <Link href="/dashboard/attendance" className={PRIMARY}>
            <CameraIcon className="size-5" />
            Take attendance
          </Link>
        ) : null}
        {dashboard && dashboard.pendingReview.length > 0 ? (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {dashboard.pendingReview.slice(0, 5).map((session) => (
              <SessionRow key={session.sessionId} session={session} returnTo="/dashboard" />
            ))}
          </ul>
        ) : null}
        {readsAttendance ? (
          <div className="flex flex-wrap gap-x-5">
            <Link href="/dashboard/attendance/sessions" className={LINK}>
              All registers
            </Link>
            <Link href="/dashboard/reports" className={LINK}>
              Reports
            </Link>
          </div>
        ) : null}
      </Panel>
    ) : null;

  const studentsCard = readsStudents ? (
    <Panel
      title="Students"
      description={
        students
          ? `${plural(students.activeAll, "student")} on roll${
              students.incompleteAll ? ` · ${students.incompleteAll} not fully set up` : ""
            }`
          : undefined
      }
    >
      <form action="/dashboard/students" method="get" role="search" className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="receptionist-student-search" className="sr-only">
          Find a student by name or student ID
        </label>
        <input
          id="receptionist-student-search"
          name="q"
          type="search"
          placeholder="Name or student ID"
          autoComplete="off"
          className="min-h-11 flex-1 rounded-lg border border-neutral-300 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none"
        />
        <button type="submit" className={SECONDARY}>
          Find a student
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {can("student.create") ? (
          <Link href="/dashboard/students/new" className={SECONDARY}>
            Add a student
          </Link>
        ) : null}
        {students && students.incompleteAll ? (
          <Link href="/dashboard/students?verification=incomplete" className={LINK}>
            Students not fully set up
          </Link>
        ) : null}
        <Link href="/dashboard/students" className={LINK}>
          All students
        </Link>
      </div>
    </Panel>
  ) : null;

  const facesCard = enrolsFaces ? (
    <Panel
      title="Face enrollment"
      description={
        facePending
          ? facePending.total === 0
            ? "Every student on roll has a face photo."
            : `${plural(facePending.total, "student")} still need a face photo.`
          : "Take students' face photos so attendance can recognise them."
      }
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {facePending && facePending.total > 0 ? (
          <Link href="/dashboard/students?verification=face_pending" className={SECONDARY}>
            Students without a face photo
          </Link>
        ) : null}
        <Link href="/dashboard/face-enrollment" className={LINK}>
          Face enrollment
        </Link>
      </div>
    </Panel>
  ) : null;

  const staffCard = hasAnyPermission(user, "institution.read", "staff.read") ? (
    <Panel title="Staff">
      <Link href="/dashboard/faculty" className={LINK}>
        Staff list
      </Link>
    </Panel>
  ) : null;

  const anything = Boolean(attendanceCard || studentsCard || facesCard || staffCard);

  return (
    <div className="flex w-full max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-0.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Today</span>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">{today.long}</h1>
        <p className="text-sm text-neutral-500">{user.name} · Receptionist</p>
      </header>
      {anything ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 lg:items-start">
          {attendanceCard}
          {studentsCard}
          {facesCard}
          {staffCard}
        </div>
      ) : (
        <Panel title="Nothing is switched on for you yet">
          <EmptyState>Ask the principal to give you access to the work you do.</EmptyState>
        </Panel>
      )}
    </div>
  );
}

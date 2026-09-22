import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getOwnAttendance } from "@/modules/attendance-review/service";
import { StudentAttendanceClient } from "./attendance-client";

/**
 * The student's own attendance record.
 *
 * Only finalized sessions appear — see
 * modules/attendance-review/service.ts#getOwnAttendance. The student is
 * resolved from the server session; no student id is ever accepted from the
 * client, here or in the refetch action the client calls.
 */
export default async function StudentAttendancePage() {
  const user = await requirePermissionOrRedirect("attendanceRecord.read.own");
  const view = await getOwnAttendance(user);

  if (!view) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <h1 className="text-xl font-semibold text-neutral-900">My attendance</h1>
        <p className="text-sm text-neutral-500">
          Your account is not linked to a student profile. Please contact your
          institution&apos;s admin.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          Student portal
        </span>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
          My attendance
        </h1>
        <p className="text-sm text-neutral-500">
          {view.fullName} · {view.studentCode}
        </p>
      </header>
      <StudentAttendanceClient initialView={view} />
    </div>
  );
}

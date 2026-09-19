import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import {
  getCohortDetailForRequest,
  getCohortFormOptionsForRequest,
} from "@/modules/cohorts/directory-service";
import {
  COHORT_FACULTY_ROLE_LABEL,
  COHORT_WORDS,
  CohortError,
  type CohortDetail,
} from "@/modules/cohorts/directory-types";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import { TableScroll } from "@/components/ui/table-scroll";
import {
  AssignTeacherControl,
  AttachSubjectControl,
  RemoveTeacherControl,
  SubjectFacultyControl,
} from "../cohort-controls";

interface PageProps {
  params: Promise<{ cohortId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * One class: who teaches it, who is in it, and — at a college — what is taught.
 *
 * The page is read-gated on `cohort.read`, and each control below is rendered
 * only for the permission that would let it succeed: `cohort.manage` for
 * staffing and renaming, `academicStructure.manage` for offering a subject.
 * Both are checked again in the services, which is where the guarantee lives;
 * hiding a control an administrator cannot use is courtesy, not security.
 *
 * A class from another institution is "does not exist" here, not "forbidden".
 * The id is a cuid off a URL and saying which would confirm the row is real.
 */
export default async function CohortDetailPage({ params, searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("cohort.read");
  const { cohortId } = await params;
  const query = await searchParams;

  let cohort: CohortDetail;
  try {
    cohort = await getCohortDetailForRequest(user, cohortId);
  } catch (error) {
    // "Does not exist" covers both a deleted class and another institution's,
    // and a 404 is how that reads in a browser.
    if (error instanceof CohortError) notFound();
    throw error;
  }

  const options = await getCohortFormOptionsForRequest(user);

  const words = COHORT_WORDS[options.institutionType];
  const isCollege = options.institutionType === "COLLEGE";
  const canManage = hasPermission(user, "cohort.manage");
  const canStructure = hasPermission(user, "academicStructure.manage");
  const canSeeStudents = hasPermission(user, "student.read");

  const justCreated = query.created === "1";
  const justSaved = query.saved === "1";

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-2">
        <Link
          href="/dashboard/academic/cohorts"
          className="text-xs text-neutral-500 hover:text-neutral-900"
        >
          ← Back to {words.plural}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold text-neutral-900">{cohort.name}</h2>
          {cohort.academicSessionIsCurrent ? <Badge tone="positive">Current year</Badge> : null}
          {cohort.teachers.length === 0 ? <Badge tone="warning">No teacher</Badge> : null}
        </div>
        <p className="text-sm text-neutral-500">
          {cohort.academicUnitName}
          {cohort.academicUnitCode ? ` (${cohort.academicUnitCode})` : ""} ·{" "}
          {cohort.academicSessionName}
          {cohort.termLabel ? ` · ${cohort.termLabel}` : ""}
          {cohort.campusName ? ` · ${cohort.campusName}` : ""}
        </p>
      </header>

      {justCreated ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          {cohort.name} is created. Assign a teacher and put students in it — a {words.singular}{" "}
          with nobody attached cannot have a register opened for it.
        </p>
      ) : null}
      {justSaved ? (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
          Saved.
        </p>
      ) : null}

      <Panel
        title="At a glance"
        action={
          canManage ? (
            <Link
              href={`/dashboard/academic/cohorts/${cohort.id}/edit`}
              className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50"
            >
              Rename
            </Link>
          ) : null
        }
      >
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Students on roll</dt>
            <dd className="text-2xl font-semibold tabular-nums text-neutral-900">
              {cohort.roster.length.toLocaleString()}
            </dd>
            {cohort.pastRosterCount > 0 ? (
              <p className="text-xs text-neutral-500">
                {cohort.pastRosterCount.toLocaleString()} no longer here
              </p>
            ) : null}
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Teachers</dt>
            <dd className="text-2xl font-semibold tabular-nums text-neutral-900">
              {cohort.teachers.length.toLocaleString()}
            </dd>
          </div>
          {isCollege ? (
            <div>
              <dt className="text-xs uppercase tracking-wide text-neutral-500">Subjects</dt>
              <dd className="text-2xl font-semibold tabular-nums text-neutral-900">
                {cohort.subjects.length.toLocaleString()}
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Registers taken</dt>
            <dd className="text-2xl font-semibold tabular-nums text-neutral-900">
              {cohort.attendanceSessionCount.toLocaleString()}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel
        title="Teachers"
        description={
          isCollege
            ? "Who is responsible for this section. Subject teaching is set per subject below."
            : "Who takes the register for this class. One class teacher, plus any additional teachers."
        }
      >
        {cohort.teachers.length === 0 ? (
          <EmptyState>
            Nobody is assigned. Until somebody is, no register can be opened for {cohort.name}.
          </EmptyState>
        ) : (
          <TableScroll minWidth="min-w-[34rem]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Role</th>
                  <th className="py-2 pr-4 font-medium">Account</th>
                  {canManage ? <th className="py-2 font-medium">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {cohort.teachers.map((teacher) => (
                  <tr key={teacher.linkId} className="border-b border-neutral-100 align-top">
                    <td className="py-3 pr-4">
                      <p className="text-sm font-medium text-neutral-900">{teacher.name}</p>
                      <p className="text-xs text-neutral-500">{teacher.email}</p>
                    </td>
                    <td className="py-3 pr-4 text-sm text-neutral-600">
                      {COHORT_FACULTY_ROLE_LABEL[teacher.role]}
                    </td>
                    <td className="py-3 pr-4">
                      {teacher.accountStatus === "ACTIVE" ? (
                        <Badge tone="positive">Active</Badge>
                      ) : (
                        <Badge tone="danger">Stopped</Badge>
                      )}
                    </td>
                    {canManage ? (
                      <td className="py-3">
                        <RemoveTeacherControl teacher={teacher} cohortName={cohort.name} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        {canManage ? (
          <div className="mt-4 border-t border-neutral-200 pt-4">
            <AssignTeacherControl cohortId={cohort.id} staff={options.staff} />
          </div>
        ) : null}
      </Panel>

      {isCollege ? (
        <Panel
          title="Subjects"
          description="What this section is taught, and who teaches each one. A register is opened per subject."
        >
          {cohort.subjects.length === 0 ? (
            <EmptyState>
              No subjects are offered to this section yet. Registers are taken per subject, so
              nothing can be marked until at least one is added.
            </EmptyState>
          ) : (
            <TableScroll minWidth="min-w-[38rem]">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2 pr-4 font-medium">Subject</th>
                    <th className="py-2 font-medium">Taught by</th>
                  </tr>
                </thead>
                <tbody>
                  {cohort.subjects.map((offering) => (
                    <tr
                      key={offering.cohortSubjectId}
                      className="border-b border-neutral-100 align-top"
                    >
                      <td className="py-3 pr-4">
                        <p className="text-sm font-medium text-neutral-900">{offering.code}</p>
                        <p className="text-xs text-neutral-500">{offering.name}</p>
                      </td>
                      <td className="py-3">
                        {canStructure ? (
                          <SubjectFacultyControl offering={offering} staff={options.staff} />
                        ) : offering.facultyName ? (
                          <span className="text-sm text-neutral-600">{offering.facultyName}</span>
                        ) : (
                          <span className="text-sm text-amber-700">Nobody yet</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}

          {canStructure ? (
            <div className="mt-4 border-t border-neutral-200 pt-4">
              <AttachSubjectControl
                cohortId={cohort.id}
                subjects={options.subjects}
                staff={options.staff}
                attached={cohort.subjects}
              />
            </div>
          ) : null}
        </Panel>
      ) : null}

      <Panel
        title="Students on roll"
        description={
          cohort.roster.length === 0
            ? "Nobody is in it yet."
            : `${cohort.roster.length.toLocaleString()} ${cohort.roster.length === 1 ? "student" : "students"}, by surname.`
        }
        action={
          canSeeStudents ? (
            <Link
              href="/dashboard/students"
              className="inline-flex items-center justify-center rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50"
            >
              Student directory
            </Link>
          ) : null
        }
      >
        {cohort.roster.length === 0 ? (
          <EmptyState>
            No students are placed in {cohort.name}. Students are placed from their own record,
            where the placement they are moving out of is visible.
          </EmptyState>
        ) : (
          <>
            <TableScroll minWidth="min-w-[28rem]">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2 pr-4 font-medium">Student</th>
                    <th className="py-2 font-medium">Code</th>
                  </tr>
                </thead>
                <tbody>
                  {cohort.roster.map((entry) => (
                    <tr key={entry.enrollmentId} className="border-b border-neutral-100">
                      <td className="py-2.5 pr-4 text-sm text-neutral-900">
                        {canSeeStudents ? (
                          <Link
                            href={`/dashboard/students/${entry.studentId}`}
                            className="hover:underline"
                          >
                            {entry.lastName}, {entry.firstName}
                          </Link>
                        ) : (
                          <>
                            {entry.lastName}, {entry.firstName}
                          </>
                        )}
                      </td>
                      <td className="py-2.5 text-sm tabular-nums text-neutral-600">
                        {entry.studentCode}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
            {/* The roster read is capped. Saying so beats a page that quietly
                shows 500 of 512 and lets somebody conclude twelve students
                were never admitted. */}
            {cohort.roster.length >= 500 ? (
              <p className="mt-3 text-xs text-amber-700">
                Showing the first 500. Use the student directory to search the rest.
              </p>
            ) : null}
          </>
        )}
      </Panel>
    </div>
  );
}

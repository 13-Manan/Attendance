import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getFacultyDirectory } from "@/modules/faculty/directory-service";
import {
  FACULTY_SORTS,
  NO_DEPARTMENT,
  NO_PASSWORD,
  NO_ROLE,
  facultyFilterQuery,
  hasActiveFacultyFilters,
  parseFacultyFilters,
} from "@/modules/faculty/directory-filters";
import { STAFF_ROLE_KEYS, type FacultyMember } from "@/modules/faculty/directory-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, EmptyState } from "@/components/ui/panel";
import { Select } from "@/components/ui/select";
import { TableScroll } from "@/components/ui/table-scroll";
import {
  AssignClassTeacherForm,
  InviteFacultyForm,
  MemberActions,
  RemoveClassLinkButton,
  SubjectFacultySelect,
} from "./faculty-controls";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const BASE = "/dashboard/faculty";

/**
 * Faculty.
 *
 * Read-gated on `institution.read` here; every control is write-gated in the
 * service on the permission that matches what it does — `user.invite`,
 * `user.update`, `user.deactivate`, `cohort.manage`. The page renders only the
 * controls the viewer may actually use, so a read-only viewer gets an honest
 * staff list rather than a row of buttons that all fail.
 *
 * ## The three questions this page answers
 *
 * Who works here, whether they can get in, and what they teach. They are on
 * one screen because the answer to "why can't Mrs Sharma open her register?"
 * is one of the three and an administrator should not have to guess which.
 *
 * ## What is paginated and what is not
 *
 * The staff table is one page of a database query — a college has hundreds of
 * accounts and nobody scrolls that. The panels below it are not: a teacher on
 * page 3 still owns their class, and the dropdown that hands out a subject
 * still has to offer them. The filters are a GET form for the reason the
 * student directory's are: a filtered list is then a URL somebody can bookmark
 * or send on, with no client JavaScript involved.
 *
 * ## What it never shows
 *
 * A password, present or past. `canSignIn` says whether one has been set — the
 * hash is not selected by anything on this path — and the only way to give
 * someone a working password is to issue a new one, which invalidates the old.
 */

function formatWhen(value: Date | null, fallback: string): string {
  if (!value) return fallback;
  return value.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * Whether this person can actually sign in, said plainly.
 *
 * Three states that look alike in a database and mean very different things to
 * an administrator: stopped, never given a password, and fine but never used.
 */
function AccessCell({ member }: { member: FacultyMember }) {
  if (member.status === "INACTIVE") {
    return <span className="text-sm text-neutral-500">Stopped</span>;
  }
  if (!member.canSignIn) {
    return (
      <span className="text-sm text-amber-700">
        No password set — issue one before they can sign in
      </span>
    );
  }
  return (
    <span className="text-sm text-neutral-600">
      {member.lastLoginAt ? `Last in ${formatWhen(member.lastLoginAt, "")}` : "Never signed in"}
    </span>
  );
}

export default async function FacultyPage({ searchParams }: PageProps) {
  const user = await requirePermissionOrRedirect("institution.read");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there is no staff
        list here.
      </p>
    );
  }

  const params = await searchParams;
  const filters = parseFacultyFilters(params);
  const directory = await getFacultyDirectory(user, filters);

  const filtered = hasActiveFacultyFilters(filters);
  const canInvite = hasPermission(user, "user.invite");
  const canManageAccounts = hasPermission(user, "user.update");
  const canAssign = hasPermission(user, "cohort.manage");

  const showDepartments = directory.isCollege && directory.departments.length > 0;
  const unassignedSubjects = directory.cohortSubjects.filter(
    (offering) => offering.facultyId === null,
  ).length;

  const firstOnPage = directory.total === 0 ? 0 : (directory.page - 1) * directory.pageSize + 1;
  const lastOnPage = Math.min(directory.page * directory.pageSize, directory.total);

  const labelClass = "flex flex-col gap-1.5 text-xs font-medium text-neutral-600";

  return (
    <div className="flex w-full max-w-6xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          People
        </span>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
          Faculty
        </h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          Everyone at this institution who takes attendance or administers it — who they are,
          whether they can sign in, and which classes and subjects are theirs.
        </p>
      </header>

      {canInvite ? (
        <InviteFacultyForm departments={showDepartments ? directory.departments : []} />
      ) : (
        <p className="text-xs text-neutral-500">
          You can see the staff list, but adding and changing accounts needs the staff-management
          permission.
        </p>
      )}

      <Panel
        title="Find someone"
        description="Search by name, work email or employee code. Terms are matched separately, so “sharma t-14” finds the Sharma with that code."
      >
        <form method="get" action={BASE} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className={labelClass}>
              Search
              <Input
                type="search"
                name="q"
                defaultValue={filters.q}
                placeholder="Name, email, employee code"
                autoComplete="off"
              />
            </label>
            <label className={labelClass}>
              Access
              <Select name="status" defaultValue={filters.status} className="px-2.5 py-1.5">
                <option value="">Active and stopped</option>
                <option value="ACTIVE">Active only</option>
                <option value="INACTIVE">Stopped only</option>
              </Select>
            </label>
            <label className={labelClass}>
              Role
              <Select name="role" defaultValue={filters.role} className="px-2.5 py-1.5">
                <option value="">Any role</option>
                <option value={NO_ROLE}>No role assigned</option>
                {STAFF_ROLE_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </Select>
            </label>
            <label className={labelClass}>
              Sort by
              <Select name="sort" defaultValue={filters.sort} className="px-2.5 py-1.5">
                {FACULTY_SORTS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>
            {showDepartments ? (
              <label className={labelClass}>
                Department
                <Select
                  name="departmentId"
                  defaultValue={filters.departmentId}
                                 >
                  <option value="">Any department</option>
                  <option value={NO_DEPARTMENT}>No department</option>
                  {directory.departments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                      {department.code ? ` (${department.code})` : ""}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            <label className={labelClass}>
              Can sign in
              <Select name="access" defaultValue={filters.access} className="px-2.5 py-1.5">
                <option value="">Everyone</option>
                <option value={NO_PASSWORD}>Never given a password</option>
              </Select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit">Search</Button>
            {filtered ? (
              <Link href={BASE}>
                <Button type="button" variant="secondary">
                  Clear filters
                </Button>
              </Link>
            ) : null}
            <p className="text-xs tabular-nums text-neutral-500">
              {directory.totalAll === 0
                ? "No staff accounts yet."
                : filtered
                  ? `${directory.total.toLocaleString()} of ${directory.totalAll.toLocaleString()} match`
                  : `${directory.activeAll.toLocaleString()} active of ${directory.totalAll.toLocaleString()}`}
            </p>
          </div>
        </form>
      </Panel>

      <Panel
        title="Staff"
        description={
          directory.total === 0
            ? "Nothing to show."
            : `Showing ${firstOnPage.toLocaleString()}–${lastOnPage.toLocaleString()} of ${directory.total.toLocaleString()}. Stopped accounts are kept so past registers still say who took them.`
        }
      >
        {directory.members.length === 0 ? (
          <EmptyState>
            {directory.totalAll === 0 ? (
              <>
                Nobody has an account yet. Add the teachers who will take attendance — each one
                gets a temporary password you hand over directly.
              </>
            ) : (
              <>
                Nothing matched. Clear the filters to see all{" "}
                {directory.totalAll.toLocaleString()} staff accounts.
              </>
            )}
          </EmptyState>
        ) : (
          <>
            <TableScroll minWidth="min-w-[56rem]">
              <table className="w-full border-collapse text-left">
                <thead className="bg-neutral-50">
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2.5 pr-4 pl-3 font-medium">Name</th>
                    <th className="py-2.5 pr-4 font-medium">Role</th>
                    {showDepartments ? (
                      <th className="py-2.5 pr-4 font-medium">Department</th>
                    ) : null}
                    <th className="py-2.5 pr-4 font-medium">Access</th>
                    <th className="py-2.5 pr-4 font-medium">Teaches</th>
                    {canManageAccounts ? <th className="py-2.5 pr-3 font-medium">Actions</th> : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {directory.members.map((member) => (
                    <tr key={member.id} className="align-top transition-colors hover:bg-neutral-50/60">
                      <td className="py-3 pr-4 first:pl-3">
                        <p className="text-sm font-medium text-neutral-900">{member.name}</p>
                        <p className="text-xs break-all text-neutral-500">{member.email}</p>
                        {member.employeeCode ? (
                          <p className="text-xs text-neutral-500">{member.employeeCode}</p>
                        ) : null}
                      </td>
                      <td className="py-3 pr-4 text-sm text-neutral-600">
                        {member.roleKeys.length === 0 ? (
                          // Visible rather than blank: an account with no role
                          // can sign in and see nothing, which reads to its owner
                          // as a broken product.
                          <span className="text-amber-700">No role assigned</span>
                        ) : (
                          member.roleKeys.join(", ")
                        )}
                      </td>
                      {showDepartments ? (
                        <td className="py-3 pr-4 text-sm text-neutral-600">
                          {member.departmentName ?? (
                            <span className="text-neutral-400">Not recorded</span>
                          )}
                        </td>
                      ) : null}
                      <td className="py-3 pr-4 first:pl-3">
                        <AccessCell member={member} />
                      </td>
                      <td className="py-3 pr-4 text-sm text-neutral-600">
                        {member.classes.length === 0 && member.subjects.length === 0 ? (
                          <span className="text-neutral-400">Nothing yet</span>
                        ) : (
                          <ul className="flex flex-col gap-0.5">
                            {member.classes.map((link) => (
                              <li key={link.linkId}>
                                {link.cohortName}
                                {link.role === "PRIMARY" ? " (class teacher)" : " (assisting)"}
                              </li>
                            ))}
                            {member.subjects.map((link) => (
                              <li key={link.cohortSubjectId} className="text-neutral-500">
                                {link.subjectCode} · {link.cohortName}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      {canManageAccounts ? (
                        <td className="py-3">
                          <MemberActions
                            member={member}
                            departments={showDepartments ? directory.departments : []}
                          />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>

            {directory.pageCount > 1 ? (
              <nav
                aria-label="Staff pages"
                className="mt-3 flex flex-wrap items-center justify-between gap-2"
              >
                {/* Links rather than buttons: a page of a list is a place, and a
                    reader should be able to open page 3 in a new tab or come
                    back to it from history. */}
                {directory.page > 1 ? (
                  <Link href={`${BASE}${facultyFilterQuery(filters, { page: directory.page - 1 })}`}>
                    <Button type="button" variant="secondary">
                      ← Previous
                    </Button>
                  </Link>
                ) : (
                  <span className="px-3 py-2 text-sm text-neutral-400">← Previous</span>
                )}
                <p className="text-xs tabular-nums text-neutral-500">
                  Page {directory.page} of {directory.pageCount}
                </p>
                {directory.page < directory.pageCount ? (
                  <Link href={`${BASE}${facultyFilterQuery(filters, { page: directory.page + 1 })}`}>
                    <Button type="button" variant="secondary">
                      Next →
                    </Button>
                  </Link>
                ) : (
                  <span className="px-3 py-2 text-sm text-neutral-400">Next →</span>
                )}
              </nav>
            ) : null}
          </>
        )}
      </Panel>

      <Panel
        title="Class teachers"
        description="Who owns a class. A class teacher can open its register; an additional teacher can help take it."
      >
        <div className="flex flex-col gap-4">
          {canAssign ? (
            <AssignClassTeacherForm
              cohorts={directory.cohorts}
              members={directory.assignable}
            />
          ) : null}

          {directory.classTeachers.length === 0 ? (
            <EmptyState>
              No class has a teacher yet. Until one does, nobody can open a register for it.
            </EmptyState>
          ) : (
            <ul className="flex flex-col gap-2">
              {directory.classTeachers.map((link) => (
                <li
                  key={link.linkId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-neutral-200 px-3 py-2"
                >
                  <span className="text-sm text-neutral-700">
                    <span className="font-medium text-neutral-900">{link.cohortName}</span>
                    {link.termLabel ? ` · ${link.termLabel}` : ""} — {link.userName}
                    {link.role === "PRIMARY" ? " (class teacher)" : " (assisting)"}
                  </span>
                  {canAssign ? <RemoveClassLinkButton linkId={link.linkId} /> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      <Panel
        title="Subjects"
        description={
          directory.cohortSubjects.length === 0
            ? "No subjects are offered in any class."
            : `${directory.cohortSubjects.length} offered. ${unassignedSubjects} have nobody assigned, and no register can be opened for those.`
        }
      >
        {directory.cohortSubjects.length === 0 ? (
          <EmptyState>
            Nothing here yet. Subjects are a college workflow: create them under Academic
            management, attach them to a class, then say who teaches each one.
          </EmptyState>
        ) : (
          <TableScroll minWidth="min-w-[40rem]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2 pr-4 font-medium">Subject</th>
                  <th className="py-2 pr-4 font-medium">Class</th>
                  <th className="py-2 font-medium">Taught by</th>
                </tr>
              </thead>
              <tbody>
                {directory.cohortSubjects.map((offering) => (
                  <tr key={offering.cohortSubjectId} className="border-b border-neutral-100 align-top">
                    <td className="py-3 pr-4">
                      <p className="text-sm font-medium text-neutral-900">{offering.subjectCode}</p>
                      <p className="text-xs text-neutral-500">{offering.subjectName}</p>
                    </td>
                    <td className="py-3 pr-4 text-sm text-neutral-600">{offering.cohortName}</td>
                    <td className="py-3">
                      {canAssign ? (
                        <SubjectFacultySelect offering={offering} members={directory.assignable} />
                      ) : (
                        <span className="text-sm text-neutral-600">
                          {offering.facultyName ?? "Nobody yet"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}

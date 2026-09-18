import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getFacultyDirectory } from "@/modules/faculty/directory-service";
import type { FacultyMember } from "@/modules/faculty/directory-types";
import { Panel, EmptyState } from "@/components/ui/panel";
import { TableScroll } from "@/components/ui/table-scroll";
import {
  AssignClassTeacherForm,
  InviteFacultyForm,
  MemberActions,
  RemoveClassLinkButton,
  SubjectFacultySelect,
} from "./faculty-controls";

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

export default async function FacultyPage() {
  const user = await requirePermissionOrRedirect("institution.read");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there is no staff
        list here.
      </p>
    );
  }

  const directory = await getFacultyDirectory(user);
  const canInvite = hasPermission(user, "user.invite");
  const canManageAccounts = hasPermission(user, "user.update");
  const canAssign = hasPermission(user, "cohort.manage");

  const active = directory.members.filter((member) => member.status === "ACTIVE").length;
  const classLinks = directory.members.flatMap((member) =>
    member.classes.map((link) => ({ member, link })),
  );
  const unassignedSubjects = directory.cohortSubjects.filter(
    (offering) => offering.facultyId === null,
  ).length;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Faculty</h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          Everyone at this institution who takes attendance or administers it — who they are,
          whether they can sign in, and which classes and subjects are theirs.
        </p>
      </header>

      {canInvite ? (
        <InviteFacultyForm />
      ) : (
        <p className="text-xs text-neutral-500">
          You can see the staff list, but adding and changing accounts needs the staff-management
          permission.
        </p>
      )}

      <Panel
        title="Staff"
        description={
          directory.members.length === 0
            ? "No staff accounts yet."
            : `${active} active of ${directory.members.length}. Stopped accounts are kept so past registers still say who took them.`
        }
      >
        {directory.members.length === 0 ? (
          <EmptyState>
            Nobody has an account yet. Add the teachers who will take attendance — each one gets a
            temporary password you hand over directly.
          </EmptyState>
        ) : (
          <TableScroll minWidth="min-w-[56rem]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Role</th>
                  <th className="py-2 pr-4 font-medium">Access</th>
                  <th className="py-2 pr-4 font-medium">Teaches</th>
                  {canManageAccounts ? <th className="py-2 font-medium">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {directory.members.map((member) => (
                  <tr key={member.id} className="border-b border-neutral-100 align-top">
                    <td className="py-3 pr-4">
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
                    <td className="py-3 pr-4">
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
                        <MemberActions member={member} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="Class teachers"
        description="Who owns a class. A class teacher can open its register; an additional teacher can help take it."
      >
        <div className="flex flex-col gap-4">
          {canAssign ? (
            <AssignClassTeacherForm cohorts={directory.cohorts} members={directory.members} />
          ) : null}

          {classLinks.length === 0 ? (
            <EmptyState>
              No class has a teacher yet. Until one does, nobody can open a register for it.
            </EmptyState>
          ) : (
            <ul className="flex flex-col gap-2">
              {classLinks.map(({ member, link }) => (
                <li
                  key={link.linkId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-neutral-200 px-3 py-2"
                >
                  <span className="text-sm text-neutral-700">
                    <span className="font-medium text-neutral-900">{link.cohortName}</span>
                    {link.termLabel ? ` · ${link.termLabel}` : ""} — {member.name}
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
                        <SubjectFacultySelect offering={offering} members={directory.members} />
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

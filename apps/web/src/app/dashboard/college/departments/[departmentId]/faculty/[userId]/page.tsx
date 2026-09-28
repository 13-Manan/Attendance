import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getDepartmentFacultyMember } from "@/modules/college-setup/service";
import { PageTrail } from "@/components/nav/page-trail";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
  AssignSectionForm,
  EditFacultyForm,
  FacultyAccessButton,
} from "@/app/dashboard/college/college-controls";
import {
  MOMENT_FORMAT,
  departmentHref,
  departmentPeopleHref,
  departmentTrail,
  readOrDeny,
  sectionHref,
} from "@/app/dashboard/college/shared";

interface PageProps {
  params: Promise<{ departmentId: string; userId: string }>;
}

/**
 * One teacher of the department: their details, whether they can sign in,
 * the sections they teach this session, and the ways to change those — for a
 * member of the department whom the viewer may manage. Somebody from another
 * department who teaches one of its sections is shown, and nothing more.
 */
export default async function DepartmentFacultyMemberPage({ params }: PageProps) {
  const user = await requireUser();
  const { departmentId, userId } = await params;
  const isAdmin = hasPermission(user, "academicStructure.manage");

  const result = await readOrDeny(() => getDepartmentFacultyMember(user, departmentId, userId));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-3xl flex-col gap-5">
        <PageTrail items={[{ label: "Faculty" }, { label: "Teacher" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const view = result.value;
  if (!view) notFound();
  const { department, session, person, isSelf, sectionChoices } = view;
  const list = departmentPeopleHref(department.id, "faculty");
  const trail = departmentTrail({
    viewer: isAdmin ? "admin" : "hod",
    department: { name: department.name, href: departmentHref(department.id) },
    list: { label: "Faculty", href: list },
    leaf: { label: person.name },
  });
  const canAssign = person.member && person.status === "ACTIVE" && Boolean(session?.isActive);

  return (
    <div className="flex w-full max-w-3xl flex-col gap-5">
      <PageTrail items={trail.items} back={trail.back} />
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-neutral-900">{person.name}</h1>
          {person.isHead ? <Badge tone="info">Head of department</Badge> : null}
          {person.departmentFaculty ? <Badge tone="neutral">Department faculty</Badge> : null}
          {person.status === "ACTIVE" ? <Badge tone="positive">Active</Badge> : <Badge tone="danger">Disabled</Badge>}
        </div>
        <p className="break-all text-sm text-neutral-500">
          {person.email}
          {person.employeeCode ? ` · Faculty ID ${person.employeeCode}` : ""}
        </p>
      </header>

      <dl className="grid gap-4 rounded-lg border border-neutral-200 bg-white p-4 text-sm sm:grid-cols-3 sm:p-5">
        <div className="flex flex-col gap-1">
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Department</dt>
          <dd className="text-neutral-900">{person.member ? department.name : "Another department"}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Sign-in</dt>
          <dd className="text-neutral-900">{person.status === "ACTIVE" ? "Can sign in" : "Disabled"}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-xs uppercase tracking-wide text-neutral-500">Last signed in</dt>
          <dd className="text-neutral-900">
            {person.lastLoginAt ? MOMENT_FORMAT.format(person.lastLoginAt) : <span className="text-neutral-500">Never</span>}
          </dd>
        </div>
      </dl>

      <Panel
        title={`Sections${session ? ` in ${session.name}` : ""} (${person.sections.length})`}
        description="The course sections this teacher takes attendance for."
      >
        {person.sections.length === 0 ? (
          <EmptyState>No section assigned yet.</EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100">
            {person.sections.map((section) => (
              <li key={section.sectionId} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                <Link
                  href={sectionHref(department.id, section.semesterId, section.courseId, section.sectionId)}
                  className="font-medium text-neutral-900 underline-offset-2 hover:underline"
                >
                  {section.courseName} — {section.label}
                </Link>
                <span className="font-mono text-xs text-neutral-500">{section.groupName}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {canAssign ? (
        <section id="assign" className="scroll-mt-4">
          <Panel
            title="Assign to a section"
            description={`One of ${department.name}'s course sections this session. A section that already has a teacher changes hands only when you choose to replace them.`}
          >
            <AssignSectionForm
              departmentId={department.id}
              userId={person.userId}
              personName={person.name}
              choices={sectionChoices}
            />
          </Panel>
        </section>
      ) : null}

      {person.manageable ? (
        <>
          <section id="details" className="scroll-mt-4">
            <Panel title="Details" description="Their email is what they sign in with, so it stays as it is.">
              <EditFacultyForm
                departmentId={department.id}
                userId={person.userId}
                name={person.name}
                employeeCode={person.employeeCode ?? ""}
              />
            </Panel>
          </section>
          <Panel
            title="Account"
            description={
              person.status === "ACTIVE"
                ? "Disabling stops them signing in at once. Their sections and past registers are kept."
                : person.enableable
                  ? "Enabling lets them sign in again with their current password."
                  : "Somebody other than you disabled this account, so only the college administrator can enable it again."
            }
          >
            {person.status === "ACTIVE" || person.enableable ? (
              <FacultyAccessButton
                departmentId={department.id}
                userId={person.userId}
                active={person.status === "ACTIVE"}
                personName={person.name}
              />
            ) : null}
            <p className="text-xs text-neutral-500">
              A forgotten password is replaced by the college administrator, who issues a new one.
            </p>
          </Panel>
        </>
      ) : isSelf ? (
        <p className="text-sm text-neutral-600">
          This is your own account.{" "}
          <Link href="/dashboard/account" className="font-medium text-neutral-900 underline underline-offset-2">
            My account
          </Link>{" "}
          is where you change your password.
        </p>
      ) : !person.member ? (
        <p className="text-sm text-neutral-600">
          {person.name} belongs to another department and teaches here. Their account is managed there.
        </p>
      ) : null}
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { sectionFullName } from "@/modules/college-setup/policy";
import { getSectionPlacement } from "@/modules/college-setup/service";
import { getStudentFormOptionsForRequest } from "@/modules/students/directory-service";
import { PageTrail } from "@/components/nav/page-trail";
import { EmptyState } from "@/components/ui/panel";
import { NewStudentWithLoginForm } from "@/app/dashboard/college/new-student-form";
import {
  COURSES_PATH,
  LINK_SECONDARY,
  courseHref,
  courseTrail,
  departmentHref,
  readOrDeny,
  sectionHref,
  sectionStudentsHref,
  semesterHref,
} from "@/app/dashboard/college/shared";

interface PageProps {
  params: Promise<{ departmentId: string; semesterId: string; courseId: string; sectionId: string }>;
}

/**
 * Admit a new student straight into a course section, with their Student
 * Portal login.
 *
 * The same form as the department's Add student page — the student service's
 * fields and checks, a required college email, the temporary password shown
 * once — with this section fixed: there is no class to choose, so the list of
 * every class in the college is never sent to the browser. Done opens the new
 * student's page.
 */
export default async function AddSectionStudentPage({ params }: PageProps) {
  const user = await requireUser();
  const ids = await params;
  const isAdmin = hasPermission(user, "academicStructure.manage");

  const result = await readOrDeny(() => getSectionPlacement(user, ids));
  if (!result.ok) {
    return (
      <div className="flex w-full max-w-2xl flex-col gap-5">
        <PageTrail items={[isAdmin ? { label: "Departments", href: "/dashboard/college/departments" } : { label: "Courses", href: COURSES_PATH }, { label: "New student" }]} />
        <EmptyState>{result.message}</EmptyState>
      </div>
    );
  }
  const placement = result.value;
  if (!placement) notFound();
  const { department, semester, course, session, section } = placement;

  // Campuses need `student.read`, which an administrator holds; a head of
  // department is not offered one — campus stays optional, as it always is.
  const options = hasPermission(user, "student.read")
    ? { campuses: (await getStudentFormOptionsForRequest(user)).campuses, cohorts: [] }
    : { campuses: [], cohorts: [] };
  const sectionPage = sectionHref(department.id, semester.id, course.id, section.id);
  const fullName = sectionFullName(course.name, section.label);
  const trail = courseTrail({
    viewer: isAdmin ? "admin" : "hod",
    department: { name: department.name, href: departmentHref(department.id) },
    semester: { name: semester.name, href: semesterHref(department.id, semester.id) },
    course: { name: course.name, code: course.code, href: courseHref(department.id, semester.id, course.id) },
    section: { label: section.label, href: sectionPage },
    leaf: "New student",
  });

  return (
    <div className="flex w-full max-w-2xl flex-col gap-5">
      <PageTrail items={trail.items} back={trail.back} />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">New student</h1>
        <p className="max-w-xl text-sm text-neutral-700">
          They will be placed in <span className="font-medium text-neutral-900">{fullName}</span> ({section.groupName},{" "}
          {session.name}).
        </p>
        <p className="max-w-xl text-sm text-neutral-500">
          A name, a student ID and their college email are required — the email is how they sign in to the Student
          Portal. They can be added to other courses&apos; sections afterwards.
        </p>
      </header>

      <nav aria-label="How to add a student" className="flex flex-wrap gap-2">
        <Link href={sectionStudentsHref(ids, "add")} className={LINK_SECONDARY}>
          Select existing student
        </Link>
        <span
          aria-current="page"
          className="inline-flex min-h-11 items-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white sm:min-h-10"
        >
          Create new student
        </span>
      </nav>

      {!session.isActive ? (
        <EmptyState>{session.name} is archived, so students can&apos;t be added to its sections.</EmptyState>
      ) : (
        <NewStudentWithLoginForm
          departmentId={department.id}
          sections={[]}
          fixedSection={{ sectionId: section.id, label: `${fullName} (${section.groupName}, ${session.name})` }}
          campuses={options.campuses}
        />
      )}
    </div>
  );
}
